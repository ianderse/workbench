/**
 * Messages between LiveAgentRelay (main thread) and the relay worker
 */

export type RelayWorkerRequest =
  | { type: 'start'; claudeDirs: string[] }
  | { type: 'subscribe'; clientId: string; cwd: string; flowDir: string; claudeDirs: string[] }
  | { type: 'unsubscribe'; clientId: string }
  | { type: 'stop' };

export type RelayWorkerMessage =
  | { type: 'ready' }
  | { type: 'error'; error: string }
  /** One message (JSON, as agent-flow's SSE stream sends it) for these clients */
  | { type: 'message'; clientIds: string[]; data: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  /** The Claude Code in an agent window (`terminalId`) runs this session now, in `cwd` (a host path) */
  | {
      type: 'window-session'; terminalId: string; sessionId: string; cwd?: string
      /** The hook that said so, and how the session started (see HookServer.onWindowSession) */
      event: 'SessionStart' | 'UserPromptSubmit'; source?: string
    }
  | { type: 'stopped' };

/** The worker's workerData */
export interface RelayWorkerData {
  /** The WSL distribution Claude Code runs in (Windows with the WSL shell), else null */
  wsl: { distro: string; mountRoot?: string } | null;
}
