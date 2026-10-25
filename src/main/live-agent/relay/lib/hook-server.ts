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
 * tool has finished), a tool call ending (PostToolUse / PostToolUseFailure: a
 * backstop for a result written late, or never, as for an agent stopped
 * mid-call), a real permission prompt (Notification), the main agent finishing
 * its turn (Stop, or StopFailure when an API error such as a rate limit ends it),
 * the session ending (SessionEnd), and a backstop completion for sub-agents
 * (SubagentStop, and StopFailure inside one). Every hook also says which agent
 * window its session runs in; SessionStart and UserPromptSubmit only say that,
 * and that the window's Claude Code runs that session now (onWindowSession).
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
  // Where the session runs (a host path: the hook script translates WSL paths)
  cwd?: string
  // How a session started (SessionStart only): startup, resume, clear or compact
  source?: string
  [key: string]: unknown
}

/** A session runs in this agent window (its terminal id) */
export interface SessionOwner {
  sessionId: string
  terminalId: string
}

/** The session the Claude Code in an agent window runs now, and where it runs */
export interface WindowSession extends SessionOwner {
  cwd?: string
  /** Which hook said so: a session starting (where it runs is where it starts) or a prompt */
  event: 'SessionStart' | 'UserPromptSubmit'
  /** How a session started (`startup`, `resume`, `clear`, `compact`), when it did */
  source?: string
}

export class HookServer implements TypedDisposable {
  private server: http.Server | null = null

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onOwner = new TypedEventEmitter<SessionOwner>()
  private readonly _onWindowSession = new TypedEventEmitter<WindowSession>()

  readonly onEvent = this._onEvent.event
  /** A hook said which agent window its session runs in (every hook says it) */
  readonly onOwner = this._onOwner.event
  /** The Claude Code in an agent window started a session (at startup, `/resume`, `/clear`) or
   *  was given a prompt in one: what the window's header shows follows it */
  readonly onWindowSession = this._onWindowSession.event

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
      // Only these two come from the window's own Claude Code turning to a session: the others
      // fire inside sub-agents and forks too, and say nothing a prompt doesn't
      if ((payload.hook_event_name === 'SessionStart' || payload.hook_event_name === 'UserPromptSubmit') && !payload.agent_id) {
        this._onWindowSession.fire({
          sessionId: payload.session_id,
          terminalId,
          event: payload.hook_event_name,
          ...(typeof payload.cwd === 'string' && payload.cwd ? { cwd: payload.cwd } : {}),
          ...(typeof payload.source === 'string' && payload.source ? { source: payload.source } : {}),
        })
      }
    }
    switch (payload.hook_event_name) {
      case 'PreToolUse':
        this.handlePreToolUse(payload)
        break
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.handlePostToolUse(payload, payload.hook_event_name === 'PostToolUseFailure')
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
        // running, so only the main agent is completed (no `endsSession`). A Stop
        // from inside an agent of the session (a /subtask fork) is that agent's
        // turn ending, not the main one's.
        if (!payload.agent_id) this.emit('agent_complete', { name: ORCHESTRATOR_NAME }, payload.session_id)
        break
      case 'StopFailure':
        // An API error (e.g. a rate limit) ended the turn: the main agent's, or,
        // inside one, the agent's own, which it doesn't survive (a fork too)
        if (!payload.agent_id) this.emit('agent_complete', { name: ORCHESTRATOR_NAME }, payload.session_id)
        else {
          const agent = this.agentOf(payload)
          if (agent) this.emit('agent_complete', { name: agent }, payload.session_id)
        }
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

  /** A tool call ended (or failed), in the main agent or a sub-agent */
  private handlePostToolUse(payload: HookPayload, isError: boolean): void {
    const { tool_name: tool, tool_use_id: id } = payload
    if (typeof tool !== 'string' || typeof id !== 'string') return
    const agent = this.agentOf(payload)
    if (agent) this.emit('tool_call_end', { agent, tool, id, ...(isError ? { isError } : {}) }, payload.session_id)
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
   *  has no effect. The node id is the launch tool_use ID from .meta.json.
   *  A background agent the session started itself (/subtask) is left out: it is done when
   *  its <task-notification> reaches the session, while its SubagentStop fires on its way
   *  there, with the agent still working. */
  private handleSubagentStop(payload: HookPayload): void {
    const subagentFile = payload.agent_transcript_path || this.subagentFile(payload)
    const meta = subagentFile ? readLaunchIdFromMeta(subagentFile) : 'none'
    if (typeof meta === 'object' && !meta.fork) this.emit('agent_complete', { name: meta.id }, payload.session_id)
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
    this._onWindowSession.dispose()
  }
}
