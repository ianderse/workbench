import * as http from 'http'
import * as path from 'path'
import { AgentEvent } from './protocol'
import { ORCHESTRATOR_NAME, HOOK_MAX_BODY_SIZE, HOOK_SERVER_HOST, LOOPBACK_HOST_PATTERN } from './constants'
import { readLaunchIdFromMeta } from './subagent-watcher'
import { createLogger } from './logger'
import { TypedEventEmitter, type TypedDisposable } from './typed-event-emitter'

const log = createLogger('HookServer')

/**
 * Lightweight HTTP server that receives Claude Code hook events.
 *
 * Tool calls and sub-agents are read from the transcripts; hooks only add what
 * transcripts can't tell us promptly: a tool call starting (PreToolUse; Claude
 * Code writes it to the transcript up to seconds later, often after a short
 * tool has finished), a real permission prompt (Notification), the main agent
 * finishing its turn (Stop), the session ending (SessionEnd), and a backstop
 * completion for sub-agents (SubagentStop). Every hook also says which agent
 * window its session runs in (SessionStart and UserPromptSubmit only say that).
 *
 * It listens on an OS-assigned port, advertised to the hook script through the
 * discovery file. Events are emitted without a timestamp; the relay stamps them
 * on its own session clock.
 */

interface HookPayload {
  session_id: string
  transcript_path?: string
  hook_event_name: string
  // The sub-agent a hook fires in (absent for the main agent)
  agent_id?: string
  // SubagentStop: the sub-agent's transcript
  agent_transcript_path?: string
  // PreToolUse
  tool_name?: string
  tool_use_id?: string
  // Notification
  notification_type?: string
  // The agent window the session runs in (added by the hook script)
  workbench_terminal_id?: string
  [key: string]: unknown
}

/** A session runs in this agent window (its terminal id) */
export interface SessionOwner {
  sessionId: string
  terminalId: string
}

export class HookServer implements TypedDisposable {
  private server: http.Server | null = null

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onOwner = new TypedEventEmitter<SessionOwner>()

  readonly onEvent = this._onEvent.event
  /** A hook said which agent window its session runs in (every hook says it) */
  readonly onOwner = this._onOwner.event

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (!LOOPBACK_HOST_PATTERN.test(req.headers.host ?? '')) {
          res.writeHead(403)
          res.end()
          return
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = []
          let size = 0
          let oversized = false
          req.on('data', (chunk: Buffer) => {
            if (oversized) return
            size += chunk.length
            chunks.push(chunk)
            if (size > HOOK_MAX_BODY_SIZE) {
              oversized = true
              chunks.length = 0
              log.warn('Request body exceeded size limit, discarding')
            }
          })
          req.on('end', () => {
            if (!oversized) {
              try {
                const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                if (!parsed || typeof parsed !== 'object' || !('session_id' in parsed) || !('hook_event_name' in parsed)
                    || typeof (parsed as HookPayload).session_id !== 'string'
                    || typeof (parsed as HookPayload).hook_event_name !== 'string') {
                  log.warn('Invalid hook payload: missing session_id or hook_event_name')
                } else {
                  this.handleHook(parsed as HookPayload)
                }
              } catch (e) {
                log.error('Failed to parse or handle hook payload:', e)
              }
            }
            // Always 200 with an empty body: we're observing, not blocking
            // (the hook script discards the response anyway)
            res.writeHead(200)
            res.end()
          })
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('Agent Flow Hook Server')
        }
      })

      this.server.on('error', reject)

      this.server.listen(0, HOOK_SERVER_HOST, () => {
        const { port } = this.server!.address() as { port: number }
        log.info(`Listening on http://${HOOK_SERVER_HOST}:${port}`)
        resolve(port)
      })
    })
  }

  private handleHook(payload: HookPayload): void {
    const terminalId = payload.workbench_terminal_id
    if (typeof terminalId === 'string' && terminalId) {
      this._onOwner.fire({ sessionId: payload.session_id, terminalId })
    }
    switch (payload.hook_event_name) {
      case 'PreToolUse':
        this.handlePreToolUse(payload)
        break
      case 'SubagentStop':
        this.handleSubagentStop(payload)
        break
      case 'Notification':
        // The agent asking: the main agent or the sub-agent the hook fires in.
        // One that can't be identified isn't shown (better than pinning the
        // prompt on another agent's call).
        if (payload.notification_type === 'permission_prompt') {
          const agent = this.agentOf(payload)
          if (agent) this.emit('permission_requested', { agent }, payload.session_id)
        }
        break
      case 'Stop':
        // The main agent finished its turn. Background sub-agents may still be
        // running, so only the main agent is completed (no `endsSession`).
        this.emit('agent_complete', { name: ORCHESTRATOR_NAME }, payload.session_id)
        break
      case 'SessionEnd':
        this.emit('agent_complete', { name: ORCHESTRATOR_NAME, endsSession: true }, payload.session_id)
        break
    }
  }

  /** A tool call (or a sub-agent launch) is starting, in the main agent or
   *  (with `agent_id`) a sub-agent, named by its launch ID. A call whose
   *  sub-agent can't be identified yet (its .meta.json isn't written) is left
   *  to the transcript. */
  private handlePreToolUse(payload: HookPayload): void {
    const { tool_name: tool, tool_use_id: id } = payload
    if (typeof tool !== 'string' || typeof id !== 'string') return
    const agent = this.agentOf(payload)
    if (agent) this.emit('tool_call_start', { agent, tool, id }, payload.session_id)
  }

  /** The agent a hook fires in: the main agent, or (with `agent_id`) a
   *  sub-agent named by its launch ID; undefined for a sub-agent that can't be
   *  identified (its .meta.json isn't written yet or has no launch ID, or the
   *  payload has no transcript path) */
  private agentOf(payload: HookPayload): string | undefined {
    if (!payload.agent_id) return ORCHESTRATOR_NAME
    const file = this.subagentFile(payload)
    const meta = file ? readLaunchIdFromMeta(file) : 'none'
    return typeof meta === 'object' ? meta.id : undefined
  }

  /** Backstop for subagent completion: the transcript's tool_result or
   *  <task-notification> normally completes it first, and a repeat completion
   *  has no effect. The node id is the launch tool_use ID from .meta.json. */
  private handleSubagentStop(payload: HookPayload): void {
    const subagentFile = payload.agent_transcript_path || this.subagentFile(payload)
    const meta = subagentFile ? readLaunchIdFromMeta(subagentFile) : 'none'
    if (typeof meta === 'object') this.emit('agent_complete', { name: meta.id }, payload.session_id)
  }

  /** The transcript file of the sub-agent a hook fires in */
  private subagentFile(payload: HookPayload): string | undefined {
    return payload.transcript_path && payload.agent_id
      ? path.join(path.dirname(payload.transcript_path), payload.session_id, 'subagents', `agent-${payload.agent_id}.jsonl`)
      : undefined
  }

  private emit(type: AgentEvent['type'], payload: Record<string, unknown>, sessionId: string): void {
    this._onEvent.fire({ time: 0, type, payload, sessionId })
  }

  dispose(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this._onEvent.dispose()
    this._onOwner.dispose()
  }
}
