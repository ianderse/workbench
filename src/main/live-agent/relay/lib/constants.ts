/**
 * Shared constants for the relay.
 * Centralizes magic numbers and strings scattered across modules.
 */

// ─── Timing ──────────────────────────────────────────────────────────────────

/** How long to wait before declaring a session inactive (ms).
 *  Claude can think for several minutes with extended thinking,
 *  so this needs to be generous to avoid false "completed" state. */
export const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/** The same, while a tool call or sub-agent is still in flight: a long build,
 *  test run or background agent can go quiet for longer than that (ms) */
export const BUSY_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

/** Interval between active-session directory scans (ms) */
export const SCAN_INTERVAL_MS = 1000

/** Fallback poll interval when fs.watch might miss events (ms) */
export const POLL_FALLBACK_MS = 3000

/** JSONL files modified within this many seconds are considered active at
 *  discovery time; a closed session stops being watched this long after it
 *  closed. Stale sessions that receive new agent activity refresh their mtime
 *  and are picked up by the next scan tick (SCAN_INTERVAL_MS), so a user
 *  resuming a long-idle session sees it attach within ~1s of their next message. */
export const ACTIVE_SESSION_AGE_S = 10 * 60 // 10 minutes

/** How long to wait for a sub-agent's .meta.json (written just after its .jsonl)
 *  before giving up on tailing that file (ms) */
export const SUBAGENT_META_WAIT_MS = 10_000

/** How long a sub-agent file started since we attached waits for its launch
 *  line (Claude Code writes it seconds late) before it's read without it (ms) */
export const SUBAGENT_LAUNCH_WAIT_MS = 10_000

/** Max events buffered per session for replay to newly connected clients */
export const MAX_EVENT_BUFFER = 5000

/** Host headers the relay's hook server answers: requests addressed to this machine.
 *  Anything else is refused, so a site whose domain is re-pointed at 127.0.0.1
 *  (DNS rebinding) can't read events or post fake hooks. */
export const LOOPBACK_HOST_PATTERN = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/

/** Maximum HTTP request body size for hook server (bytes) */
export const HOOK_MAX_BODY_SIZE = 1024 * 1024 // 1 MB

/** Length of workspace hash prefix used in discovery file names */
export const WORKSPACE_HASH_LENGTH = 16

/** Session ID display truncation (logs) */
export const SESSION_ID_DISPLAY = 8

// ─── Strings ─────────────────────────────────────────────────────────────────

/** Message hash prefix max (for dedup hashing) */
export const HASH_PREFIX_MAX = 200

/** Hook server listen address */
export const HOOK_SERVER_HOST = '127.0.0.1'

/** Default agent name for the main orchestrator */
export const ORCHESTRATOR_NAME = 'orchestrator'

/** Tool calls that get no node: a sub-agent's SubagentHandback (Claude Code
 *  2.1.300+) only hands its report back to its caller as its last step, which
 *  the graph already shows as the sub-agent completing */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set(['SubagentHandback'])
