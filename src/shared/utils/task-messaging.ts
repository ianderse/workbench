/**
 * Session names of task messaging
 * ===============================
 *
 * Every task run's Claude Code session is named `wb-<projectKey>-<specId>` (`--name`), and the
 * project's lead session `wb-<projectKey>-lead`, so sessions can address each other (native
 * `SendMessage`, Workbench's `message_task`) and Workbench can tell which task a name belongs to.
 * Names only hold `[A-Za-z0-9_-]`, which Claude Code accepts without quotes.
 *
 * The project key is a short stable hash of the project id: two projects can hold the same spec
 * id, and the key keeps their sessions apart.
 */

const KEY_LENGTH = 6;
const MAX_NAME_LENGTH = 80;
const NAME_PATTERN = /^wb-([a-z0-9]{6})-([A-Za-z0-9_-]+)$/;

/** Short stable key of a project id (FNV-1a, base 36) */
export function projectKey(projectId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < projectId.length; i++) {
    hash ^= projectId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(KEY_LENGTH, '0').slice(-KEY_LENGTH);
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
}

/** Session name of a task's Claude Code session */
export function taskSessionName(projectId: string, specId: string): string {
  return `wb-${projectKey(projectId)}-${sanitize(specId)}`.slice(0, MAX_NAME_LENGTH);
}

/** Session name of the project's lead session */
export function leadSessionName(projectId: string): string {
  return `wb-${projectKey(projectId)}-lead`;
}

export type ParsedSessionName =
  | { projectKey: string; lead: true }
  | { projectKey: string; lead: false; specId: string };

/** The project key and task (or lead) a session name stands for; null for other names */
export function parseSessionName(name: string): ParsedSessionName | null {
  const match = NAME_PATTERN.exec(name.trim().replace(/^@/, ''));
  if (!match) return null;
  return match[2] === 'lead' ? { projectKey: match[1], lead: true } : { projectKey: match[1], lead: false, specId: match[2] };
}
