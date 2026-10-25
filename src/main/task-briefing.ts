/**
 * "Since this ticket was written": a system prompt section for a task that starts after other
 * tasks were merged. Tickets are written before the code exists (often many at once), so a later
 * ticket goes stale as the earlier ones land. The section lists what merged since the ticket was
 * created: each task's summary, the files it touched and the follow-ups it left open.
 *
 * `buildSinceWrittenPrompt()` is pure. `collectMergedSince()` gathers its input from the task
 * list and the project's changelog (see `task-changelog.ts`).
 */
import type { Task } from '../shared/types';
import { readTaskChangelog, type TaskChangelogEntry } from './task-changelog';

/** Total size of the section's task entries */
export const BRIEFING_MAX_CHARS = 6000;
const SUMMARY_CHARS_DEPENDENCY = 1400;
const SUMMARY_CHARS_OTHER = 600;
const MAX_FILES_DEPENDENCY = 20;
const MAX_FILES_OTHER = 10;
const MAX_FOLLOW_UPS = 6;
const FOLLOW_UP_CHARS = 240;
/** An entry is only squeezed down to this size; below it the remaining tasks are left out */
const MIN_ENTRY_CHARS = 260;
const OMITTED_LINE_RESERVE = 130;

export interface MergedTaskBrief {
  id: string;
  title: string;
  /** ISO time the task was merged */
  mergedAt: string;
  summary?: string;
  files: string[];
  followUps: string[];
}

export interface BriefedTask {
  id: string;
  /** ISO time the ticket was created */
  createdAt: string;
  dependsOnTaskIds?: string[];
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The task's ids plus everything it depends on, directly or through other tasks */
export function transitiveDependencies(taskId: string, tasks: readonly Pick<Task, 'id' | 'metadata'>[]): Set<string> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const result = new Set<string>();
  const stack = [...(byId.get(taskId)?.metadata?.dependsOnTaskIds ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === taskId || result.has(id)) continue;
    result.add(id);
    stack.push(...(byId.get(id)?.metadata?.dependsOnTaskIds ?? []));
  }
  return result;
}

/**
 * Follow-ups a summary lists: the lines under a "Follow-ups" / "Follow up" / "Next steps" / "Open
 * items" / "TODO" heading or label, up to the next blank line or heading.
 */
export function extractSummaryFollowUps(summary: string | undefined): string[] {
  if (!summary) return [];
  const lines = summary.split('\n');
  const found: string[] = [];
  const label = /^\s*(?:#{1,6}\s*|\*\*|[-*]\s*)?(?:follow[\s-]*ups?|next steps?|open (?:items|questions)|remaining work|todo)\b[^\n]*$/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!label.test(line)) continue;
    // "Follow-ups: add X" on one line
    const inline = /^[^:]*:\s*\**\s*(\S.*)$/.exec(line.replace(/\*\*/g, ''));
    if (inline && inline[1].trim()) found.push(inline[1].trim());
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next.trim() || /^\s*#{1,6}\s/.test(next)) break;
      const item = next.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
      if (item) found.push(item);
    }
  }
  return found;
}

/** Open follow-ups of a finished task: minor findings left unfixed, open review findings, summary follow-ups */
export function collectFollowUps(run: Task['claudeRun'] | undefined): string[] {
  if (!run) return [];
  const items: string[] = [];
  for (const finding of run.validation?.findings ?? []) {
    if (finding.fixed) continue;
    const where = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : '';
    items.push(`${finding.severity}: ${finding.description}${where}`);
  }
  for (const finding of run.reviewVerdict?.failure?.openFindings ?? []) {
    const where = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : '';
    items.push(`${finding.severity}: ${finding.description}${where}`);
  }
  items.push(...extractSummaryFollowUps(run.summary));
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase().slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Merge time and branch files of the done tasks, from the changelog: the done state entry's time,
 * and the files of the task's last entries before it (the branch is gone by then).
 */
export function mergedFromChangelog(entries: readonly TaskChangelogEntry[]): Map<string, { mergedAt: string; files: string[] }> {
  const files = new Map<string, Set<string>>();
  const merged = new Map<string, { mergedAt: string; files: string[] }>();
  for (const entry of entries) {
    if (entry.event === 'state' && entry.status === 'done') {
      merged.set(entry.task, { mergedAt: entry.at, files: [...(entry.files?.length ? entry.files : files.get(entry.task) ?? [])].sort() });
      continue;
    }
    if (!entry.files) continue;
    // A state entry carries the whole branch diff; edits add to it
    const current = entry.event === 'state' ? new Set<string>() : files.get(entry.task) ?? new Set<string>();
    for (const file of entry.files) current.add(file);
    files.set(entry.task, current);
  }
  return merged;
}

/**
 * The tasks merged after `task` was created, as briefing input. `merged` comes from the changelog;
 * a done task the changelog does not know falls back to its last update time.
 */
export function collectMergedSince(
  task: BriefedTask,
  tasks: readonly Task[],
  merged: ReadonlyMap<string, { mergedAt: string; files: string[] }>
): MergedTaskBrief[] {
  const createdAt = Date.parse(task.createdAt);
  const result: MergedTaskBrief[] = [];
  for (const other of tasks) {
    if (other.id === task.id || other.status !== 'done' || other.metadata?.archivedAt) continue;
    const info = merged.get(other.id) ?? merged.get(other.specId);
    const mergedAt = info?.mergedAt ?? new Date(other.updatedAt).toISOString();
    if (Number.isFinite(createdAt) && Date.parse(mergedAt) <= createdAt) continue;
    result.push({
      id: other.id,
      title: other.title,
      mergedAt,
      summary: other.claudeRun?.summary,
      files: info?.files ?? [],
      followUps: collectFollowUps(other.claudeRun),
    });
  }
  return result;
}

function renderEntry(brief: MergedTaskBrief, isDependency: boolean, budget: number): string {
  const head = `- \`${brief.id}\` "${brief.title.replace(/"/g, "'")}"${isDependency ? ' (this ticket depends on it)' : ''}, merged ${brief.mergedAt.slice(0, 10)}`;
  const maxFiles = isDependency ? MAX_FILES_DEPENDENCY : MAX_FILES_OTHER;
  const shown = brief.files.slice(0, maxFiles);
  const more = brief.files.length > shown.length ? `, and ${brief.files.length - shown.length} more` : '';
  const files = shown.length ? `\n  Files: ${shown.map((f) => `\`${f}\``).join(', ')}${more}` : '';
  const followUps = brief.followUps.slice(0, MAX_FOLLOW_UPS).map((f) => `\n  - ${clip(f, FOLLOW_UP_CHARS)}`).join('');
  const followBlock = followUps ? `\n  Open follow-ups:${followUps}` : '';

  const fixed = head.length + files.length + followBlock.length;
  const summaryBudget = Math.min(isDependency ? SUMMARY_CHARS_DEPENDENCY : SUMMARY_CHARS_OTHER, Math.max(0, budget - fixed - 14));
  const summary = brief.summary && summaryBudget > 40 ? `\n  Summary: ${clip(brief.summary, summaryBudget)}` : '';
  const full = `${head}${summary}${files}${followBlock}`;
  if (full.length <= budget) return full;
  // Squeeze: head and files only, then the head alone
  const compact = `${head}${files}`;
  return compact.length <= budget ? compact : head.slice(0, budget);
}

/**
 * The "Since this ticket was written" section, or undefined when nothing merged since. The ticket's
 * own dependencies (transitively) come first, oldest merge first, then the other tasks, newest first.
 * The size is capped: what does not fit is left out, least related and oldest last.
 */
export function buildSinceWrittenPrompt(
  merged: readonly MergedTaskBrief[],
  dependencyIds: ReadonlySet<string>,
  maxChars: number = BRIEFING_MAX_CHARS
): string | undefined {
  if (merged.length === 0) return undefined;
  const byTime = (a: MergedTaskBrief, b: MergedTaskBrief) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt);
  const deps = merged.filter((m) => dependencyIds.has(m.id)).sort(byTime);
  const others = merged.filter((m) => !dependencyIds.has(m.id)).sort((a, b) => byTime(b, a));
  const ordered = [...deps.map((m) => ({ m, dep: true })), ...others.map((m) => ({ m, dep: false }))];

  const header = `## Since this ticket was written
This ticket was written before the work below was merged into the base branch, so parts of it may be out of date: code it asks you to create may exist now, names and files may have changed, and earlier tasks may have left follow-ups. The code you see is the truth; where the ticket and the code disagree, follow the code and the intent of the ticket, and say what you adjusted in your final summary.${dependencyIds.size > 0 ? '\nTasks this ticket depends on are listed first.' : ''}`;
  // Room for the line that says how many tasks were left out
  const budget = maxChars - header.length - OMITTED_LINE_RESERVE;

  const entries: string[] = [];
  let used = 0;
  let left = 0;
  for (let i = 0; i < ordered.length; i++) {
    const remaining = budget - used;
    if (remaining < MIN_ENTRY_CHARS) {
      left = ordered.length - i;
      break;
    }
    const entry = renderEntry(ordered[i].m, ordered[i].dep, remaining);
    entries.push(entry);
    used += entry.length + 1;
  }
  const omitted = left > 0 ? `\n- ${left} more merged task${left === 1 ? '' : 's'} left out to keep this short; look in the project changelog for them.` : '';

  return `${header}\n${entries.join('\n')}${omitted}`;
}

/** The section for a task about to start, from the project's tasks and changelog (undefined when nothing merged since) */
export async function buildTaskBriefing(task: Task, allTasks: readonly Task[], changelogPath?: string): Promise<string | undefined> {
  const entries = changelogPath ? await readTaskChangelog(changelogPath) : [];
  const brief = collectMergedSince(
    { id: task.id, createdAt: new Date(task.createdAt).toISOString() },
    allTasks,
    mergedFromChangelog(entries)
  );
  return buildSinceWrittenPrompt(brief, transitiveDependencies(task.id, allTasks));
}
