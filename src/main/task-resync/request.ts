/**
 * Resync requests
 * ===============
 *
 * A task's pending "take in your base branch" request, kept in `<specDir>/resync_request.json` so
 * it survives restarts. Merge sync writes one when another task is merged into the task's base
 * branch; the task's next run (started by the resync service, the queue, a rate-limit resume or the
 * user) applies it first. Several merges before that coalesce into one request for the latest ref.
 *
 * The file is separate from `claude_run.json` on purpose: a running task's run rewrites that file
 * from memory, which would drop a request written meanwhile.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import path from 'path';
import { writeFileAtomicSync } from '../utils/atomic-file';

export const RESYNC_REQUEST_FILE = 'resync_request.json';

/** A task merged into the base branch, as the resync prompt names it */
export interface ResyncMergedTask {
  specId: string;
  title?: string;
  /** Files its branch changed */
  files: string[];
}

export interface ResyncRequest {
  /** What to merge: the base branch (`main`), or the remote one after a merged PR (`origin/main`) */
  ref: string;
  /** The base branch's name */
  into: string;
  via: 'local' | 'pr';
  /** The tasks merged into the base branch since the task last took it in */
  merged: ResyncMergedTask[];
  /** When the request was last updated (a run clears only the request it applied) */
  at: string;
  /** Set when Workbench told the task about a merge in progress or uncommitted changes */
  notedAt?: string;
  /** The last resync of this request failed: no automatic retry, a manual start retries it */
  failedAt?: string;
  error?: string;
}

const fileOf = (specDir: string) => path.join(specDir, RESYNC_REQUEST_FILE);

/** The task's pending request, or undefined */
export function readResyncRequest(specDir: string): ResyncRequest | undefined {
  const file = fileOf(specDir);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ResyncRequest;
    if (typeof parsed?.ref !== 'string' || typeof parsed.into !== 'string' || typeof parsed.at !== 'string') return undefined;
    return { ...parsed, merged: Array.isArray(parsed.merged) ? parsed.merged : [] };
  } catch {
    return undefined;
  }
}

function write(specDir: string, request: ResyncRequest): void {
  mkdirSync(specDir, { recursive: true });
  writeFileAtomicSync(fileOf(specDir), JSON.stringify(request, null, 2));
}

/**
 * Record that `merged` went into the task's base branch: a new request, or the pending one updated
 * to the latest ref (its earlier merged tasks kept, a failure forgotten)
 */
export function recordResyncRequest(
  specDir: string,
  next: { ref: string; into: string; via: 'local' | 'pr'; merged: ResyncMergedTask },
  now = new Date(),
): ResyncRequest {
  const previous = readResyncRequest(specDir);
  const merged = (previous && previous.into === next.into ? previous.merged : [])
    .filter((task) => task.specId !== next.merged.specId);
  merged.push(next.merged);
  const request: ResyncRequest = { ref: next.ref, into: next.into, via: next.via, merged, at: now.toISOString() };
  write(specDir, request);
  return request;
}

/** Forget the request, when it is still the one applied (`at`); undefined `at`: whatever it is */
export function clearResyncRequest(specDir: string, at?: string): void {
  const current = readResyncRequest(specDir);
  if (!current && !existsSync(fileOf(specDir))) return;
  if (at !== undefined && current && current.at !== at) return;
  try {
    unlinkSync(fileOf(specDir));
  } catch {
    // Already gone
  }
}

/** Update fields of the pending request (when it is still the one meant by `at`) */
export function updateResyncRequest(specDir: string, at: string, fields: Partial<Pick<ResyncRequest, 'notedAt' | 'failedAt' | 'error'>>): void {
  const current = readResyncRequest(specDir);
  if (!current || current.at !== at) return;
  write(specDir, { ...current, ...fields });
}
