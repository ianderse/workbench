/**
 * Resync requests
 * ===============
 *
 * A task's pending "take in your base branch" request, kept in `<specDir>/resync_request.json` so
 * it survives restarts. Merge sync writes one when another task is merged into the task's base
 * branch; the task's next run (started by the resync service, the queue, a rate-limit resume or the
 * user) applies it first. Several merges before that coalesce into one request that merges every
 * ref they named (the local base branch and `origin/<base>` need not contain each other).
 *
 * A request is only cleared once Workbench verified the merge (`git.ts`, `verifyResync`): the
 * commits a resync merged are kept in `unverified` until then, so a merge that never passed the
 * check is checked (and validated) on the next start instead of being taken as done.
 *
 * The file is separate from `claude_run.json` on purpose: a running task's run rewrites that file
 * from memory, which would drop a request written meanwhile.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import path from 'path';
import type { Task } from '../../shared/types';
import { writeFileAtomicSync } from '../utils/atomic-file';
import { sanitizeChangedFiles } from '../../shared/utils/changed-files';

export const RESYNC_REQUEST_FILE = 'resync_request.json';

/** A task merged into the base branch, as the resync prompt names it */
export interface ResyncMergedTask {
  specId: string;
  title?: string;
  /** Files its branch changed */
  files: string[];
}

/** A commit a resync merged (or started to merge), with the ref it was read from */
export interface ResyncTarget {
  ref: string;
  commit: string;
}

export interface ResyncRequest {
  /** What to merge: the base branch (`main`), or the remote one after a merged PR (`origin/main`); the latest one */
  ref: string;
  /** Every ref to merge (`ref` among them); older files have only `ref` */
  refs?: string[];
  /** The base branch's name */
  into: string;
  /** 'local' when any merge it carries was local (its commits are not pushed) */
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
  /** Commits merged (or being merged) that have not passed Workbench's check of the merge yet */
  unverified?: ResyncTarget[];
  /** Base-branch lines the session said must go (with a reason), for the check */
  dropped?: Array<{ file: string; line: string }>;
}

/** Every ref the request merges, oldest first */
export function resyncRefs(request: Pick<ResyncRequest, 'ref' | 'refs'>): string[] {
  return [...new Set([...(request.refs ?? []).filter((ref) => typeof ref === 'string' && ref), request.ref])];
}

/**
 * A local merge pushes nothing, so the local base branch is kept out of a task with a pull request:
 * Merge PR pushes the task's branch, which would carry those commits into the PR. Every start
 * (the resync service, the queue, the user) applies a request only when this is false
 */
export function keepsLocalMergeOut(request: { via: 'local' | 'pr' }, task: Pick<Task, 'status' | 'metadata'>): boolean {
  if (request.via !== 'local') return false;
  const { prUrl, prState } = task.metadata ?? {};
  return task.status === 'pr_created' || (!!prUrl && prState !== 'merged' && prState !== 'closed');
}

const fileOf = (specDir: string) => path.join(specDir, RESYNC_REQUEST_FILE);

/** The task's pending request, or undefined */
export function readResyncRequest(specDir: string): ResyncRequest | undefined {
  const file = fileOf(specDir);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ResyncRequest;
    if (typeof parsed?.ref !== 'string' || typeof parsed.into !== 'string' || typeof parsed.at !== 'string') return undefined;
    // Requests written before pseudo paths (`agent:/x`, `conflict:/1`) were filtered may list them
    const merged = Array.isArray(parsed.merged)
      ? parsed.merged.map((task) => ({ ...task, files: sanitizeChangedFiles(task.files) }))
      : [];
    return { ...parsed, merged };
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
 * (its refs, merged tasks, unverified merges and failure kept: a failed resync waits for the user)
 */
export function recordResyncRequest(
  specDir: string,
  next: { ref: string; into: string; via: 'local' | 'pr'; merged: ResyncMergedTask },
  now = new Date(),
): ResyncRequest {
  const found = readResyncRequest(specDir);
  const previous = found && found.into === next.into ? found : undefined;
  const merged = (previous?.merged ?? []).filter((task) => task.specId !== next.merged.specId);
  merged.push(next.merged);
  const refs = [...(previous ? resyncRefs(previous) : []).filter((ref) => ref !== next.ref), next.ref];
  const request: ResyncRequest = {
    ref: next.ref,
    ...(refs.length > 1 ? { refs } : {}),
    into: next.into,
    via: previous?.via === 'local' || next.via === 'local' ? 'local' : 'pr',
    merged,
    at: now.toISOString(),
    ...(previous?.failedAt ? { failedAt: previous.failedAt, error: previous.error } : {}),
    ...(found?.unverified?.length ? { unverified: found.unverified } : {}),
    ...(previous?.dropped?.length ? { dropped: previous.dropped } : {}),
  };
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
export function updateResyncRequest(
  specDir: string,
  at: string,
  fields: Partial<Pick<ResyncRequest, 'notedAt' | 'failedAt' | 'error' | 'dropped'>>,
): void {
  const current = readResyncRequest(specDir);
  if (!current || current.at !== at) return;
  write(specDir, { ...current, ...fields });
}

/**
 * The resync of the pending request failed: no automatic retry until the user starts the task.
 * Marks whatever request is pending now (one coalesced meanwhile carries the failed refs too)
 */
export function markResyncFailed(specDir: string, error: string, now = new Date()): void {
  const current = readResyncRequest(specDir);
  if (!current) return;
  write(specDir, { ...current, failedAt: now.toISOString(), error });
}

/** Remember commits a resync is about to merge (or found merged): they stay until verified */
export function addUnverifiedTargets(specDir: string, targets: ResyncTarget[]): void {
  const current = readResyncRequest(specDir);
  if (!current) return;
  const known = new Set((current.unverified ?? []).map((t) => t.commit));
  const added = targets.filter((t) => !known.has(t.commit));
  if (added.length === 0) return;
  write(specDir, { ...current, unverified: [...(current.unverified ?? []), ...added] });
}

/**
 * The merge of `verified` passed the check: forget the request when it is still the one applied
 * (`at`), else drop those commits from the newer one (it is applied by the next run)
 */
export function resolveResyncRequest(specDir: string, at: string, verified: ResyncTarget[]): void {
  const current = readResyncRequest(specDir);
  if (!current) return;
  if (current.at === at) {
    clearResyncRequest(specDir, at);
    return;
  }
  const done = new Set(verified.map((t) => t.commit));
  const unverified = (current.unverified ?? []).filter((t) => !done.has(t.commit));
  write(specDir, { ...current, unverified: unverified.length ? unverified : undefined });
}
