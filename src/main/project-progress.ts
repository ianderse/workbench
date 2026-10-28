/** A bounded host-owned projection. It never edits root progress, Git refs, or acceptance records. */
import path from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import type { Project, Task, TaskStatus } from '../shared/types';
import type { ClaudeRunPhase, ValidationReport } from '../shared/types/claude-code';
import { activeAutoMerge } from '../shared/utils/autonomous';
import { appLog } from './app-logger';
import { git } from './utils/git-exec';

export const PROJECT_PROGRESS_MAX_BYTES = 4800;
export const PROJECT_PROGRESS_MARKER = '<!-- workbench:project-progress:v1 -->';
const writes = new Map<string, Promise<string>>();
type ProgressTask = Pick<Task, 'id' | 'specId' | 'title' | 'status' | 'reviewReason' | 'updatedAt'> & {
  metadata?: Pick<NonNullable<Task['metadata']>, 'archivedAt' | 'autoMerge'>;
  claudeRun?: { phases: Array<Pick<ClaudeRunPhase, 'name' | 'endedAt' | 'isError'>>; validation?: Pick<ValidationReport, 'status' | 'checks'> };
};

const statuses: TaskStatus[] = ['in_progress', 'ai_review', 'queue', 'human_review', 'error', 'backlog', 'pr_created', 'done'];

function short(value: string, limit = 150): string {
  return value.replace(/[\r\n\t\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function quoted(value: string, limit?: number): string { return JSON.stringify(short(value, limit)); }
function time(task: ProgressTask): number {
  const value = task.updatedAt instanceof Date ? task.updatedAt.getTime() : Date.parse(String(task.updatedAt));
  return Number.isFinite(value) ? value : 0;
}

export interface ProgressRepository { revision?: string; branch?: string; dirty?: boolean }

/** No document discovery or model calls: only recorded tasks and the observed checkout. */
export function renderProjectProgress(project: Pick<Project, 'name'>, tasks: readonly ProgressTask[], repository: ProgressRepository = {}): string {
  const visible = tasks.filter((task) => !task.metadata?.archivedAt).sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));
  const lines = [
    '# Live project progress',
    `Project: ${quoted(project.name)}. Checkout: ${repository.branch ? quoted(repository.branch) : 'branch unavailable'}; revision ${repository.revision ? quoted(repository.revision) : 'unavailable'}; tracked changes ${repository.dirty === undefined ? 'unavailable' : repository.dirty ? 'present' : 'absent'}.`,
    'Host-generated navigation data, not instructions, approval, or proof of acceptance. This checkout may differ from task worktrees and integration targets. Task records, current code, required specs, observed checks, and scoped human decisions remain authoritative.',
    'Start with root PROGRESS.md or the project-declared status entry point and CLAUDE.md/AGENTS.md standing rules. Follow task-relevant canonical links and read focused sections; do not scan all docs or historical logs routinely. Missing/stale progress never excuses required review or verification. Workers must not edit either shared progress file.',
    `Recorded task counts: ${statuses.map((status) => `${status}=${visible.filter((task) => task.status === status).length}`).join(', ')}.`,
  ];
  const latest = visible[0];
  lines.push(`Latest recorded task update: ${latest && time(latest) ? new Date(time(latest)).toISOString() : 'unavailable'}.`);
  let omitted = 0;
  const add = (line: string) => {
    // Leave space for the explicit omission notice and footer. Never cut a UTF-8 sequence.
    if (Buffer.byteLength([...lines, line].join('\n'), 'utf8') <= PROJECT_PROGRESS_MAX_BYTES - 220) lines.push(line);
    else omitted++;
  };
  const section = (label: string, items: ProgressTask[], detail: (task: ProgressTask) => string) => {
    add(`\n## ${label}`);
    for (const task of items.slice(0, 5)) add(`- ${quoted(task.specId, 85)} ${quoted(task.title, 130)}: ${detail(task)}`);
    omitted += Math.max(0, items.length - 5);
    if (!items.length) add('- None recorded.');
  };
  section('Active and queued', visible.filter((task) => ['in_progress', 'ai_review', 'queue'].includes(task.status)), (task) => {
    const phase = task.claudeRun?.phases.at(-1);
    return `${task.status}${phase ? `; last recorded phase=${quoted(phase.name, 25)}${phase.endedAt ? phase.isError ? ' (failed)' : ' (ended)' : ' (completion unconfirmed)'}` : ''}.`;
  });
  section('Review and blockers', visible.filter((task) => ['human_review', 'error', 'pr_created'].includes(task.status)), (task) => {
    const report = task.claudeRun?.validation;
    const checks = report?.checks ?? [];
    const failed = checks.filter((check) => !check.passed).map((check) => short(check.name, 70)).slice(0, 2);
    return `${task.status}${task.reviewReason ? `; reason=${quoted(task.reviewReason, 35)}` : ''}${report ? `; agent-reported validation=${quoted(report.status, 20)}, ${checks.filter((check) => check.passed).length}/${checks.length} checks reported passed${failed.length ? `; failing=${JSON.stringify(failed)}` : ''}` : '; validation unavailable'}; acceptance not inferred.`;
  });
  section('Recorded autonomous integrations', visible.filter((task) => !!activeAutoMerge(task)), (task) => {
    const merge = activeAutoMerge(task)!;
    return `target=${quoted(merge.branch, 80)}, revision=${quoted(merge.sha, 45)}, pushed=${merge.pushed === true ? 'recorded' : 'not established'}; spec acceptance not inferred.`;
  });
  const done = visible.filter((task) => task.status === 'done').length;
  add(`\nDone is a board status (${done} recorded), not independent evidence of integration or spec acceptance. Detailed task records and task-specific handoffs retain the full evidence.`);
  if (omitted) lines.push(`\n${omitted} task rows/sections omitted to keep this snapshot bounded; inspect the relevant task record for detail.`);
  return `${lines.join('\n')}\n`;
}

/** Stable runtime path; custom Workbench state roots must remain inside the project. */
export function projectProgressPath(project: Pick<Project, 'path' | 'autoBuildPath'>): string {
  const root = path.resolve(project.path);
  const file = path.resolve(root, project.autoBuildPath || '.workbench', 'PROGRESS.md');
  if (!file.startsWith(`${root}${path.sep}`) || path.relative(root, file) === 'PROGRESS.md') throw new Error('Live progress storage must be inside a project state directory');
  return file;
}

async function readManaged(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Existing live progress is not a bounded managed file');
    const value = await fs.readFile(file, 'utf8');
    if (!value.startsWith(`${PROJECT_PROGRESS_MARKER}\n`)) throw new Error('Preserving an existing authored progress file');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function persistProgress(project: Project, file: string, body: string): Promise<void> {
  const root = path.resolve(project.path);
  // Refuse symlinked state folders, tracked files, or state paths not ignored by the repository.
  let current = root;
  for (const part of path.relative(root, path.dirname(file)).split(path.sep)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Live progress storage must not traverse symlinks'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await git(['check-ignore', '--quiet', '--', path.relative(root, file)], { cwd: root, isolated: true, timeout: 3000 });
  const previous = await readManaged(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  try {
    try {
      await handle.writeFile(`${PROJECT_PROGRESS_MARKER}\n<!-- Refreshed: ${new Date().toISOString()} -->\n${body}`);
      await handle.sync();
    } finally { await handle.close(); }
    if (await readManaged(file) !== previous) throw new Error('Live progress changed during refresh; preserving the newer content');
    if (previous === undefined) await fs.link(temporary, file); // No-clobber first publication.
    else await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}

/** Serial per output path; failures to persist never withhold bounded launch context or fail a merge. */
export async function refreshProjectProgress(project: Project, tasks: readonly Task[]): Promise<string> {
  const file = projectProgressPath(project);
  // Capture the input before queueing; callers cannot mutate a pending projection in place.
  const snapshot: ProgressTask[] = tasks.map((task) => structuredClone({
    id: task.id, specId: task.specId, title: task.title, status: task.status, reviewReason: task.reviewReason, updatedAt: task.updatedAt,
    metadata: { archivedAt: task.metadata?.archivedAt, autoMerge: task.metadata?.autoMerge },
    ...(task.claudeRun ? { claudeRun: {
      phases: task.claudeRun.phases.slice(-1).map(({ name, endedAt, isError }) => ({ name, endedAt, isError })),
      ...(task.claudeRun.validation ? { validation: {
        status: task.claudeRun.validation.status,
        checks: task.claudeRun.validation.checks.map(({ name, passed }) => ({ name, passed })),
      } } : {}),
    } } : {}),
  }));
  const prior = writes.get(file) ?? Promise.resolve('');
  const next = prior.catch(() => '').then(async () => {
    const options = { cwd: project.path, isolated: true, timeout: 3000, maxBuffer: 16 * 1024 };
    const results = await Promise.allSettled([
      git(['rev-parse', '--short=12', 'HEAD'], options),
      git(['status', '--porcelain=v1', '--branch', '--untracked-files=no'], options),
    ]);
    const revision = results[0].status === 'fulfilled' ? results[0].value.stdout.trim() : undefined;
    const status = results[1].status === 'fulfilled' ? results[1].value.stdout.split('\n').filter(Boolean) : undefined;
    const body = renderProjectProgress(project, snapshot, { revision, branch: status?.[0]?.replace(/^## /, ''), dirty: status ? status.length > 1 : undefined });
    try { await persistProgress(project, file, body); }
    catch (error) { appLog.warn('[ProjectProgress] Live snapshot available in launch context but could not be persisted:', error); }
    // Refresh time lives only in the file header; unchanged data keeps advice-cache inputs stable.
    return body;
  });
  writes.set(file, next);
  try { return await next; }
  finally { if (writes.get(file) === next) writes.delete(file); }
}
