/**
 * Diff for the fresh-context review (OMP)
 * =======================================
 *
 * Under OMP, Workbench runs the review itself: a separate one-shot run that sees only the task and
 * the diff. This module collects that diff (everything the task changed against its base branch,
 * committed or not, plus new files) with generated folders and lockfiles left out, and cuts it to
 * a size a local model can read.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { git } from '../utils/git-exec';
import { buildReviewExcludes } from './stage-excludes';

/** Characters of diff handed to the reviewer (about 15k tokens) */
export const MAX_REVIEW_DIFF_CHARS = 60_000;
/** Longest new file shown whole */
const MAX_UNTRACKED_FILE_CHARS = 8_000;

export interface ReviewDiffParts {
  /** `git diff --stat` output */
  stat: string;
  /** Unified diff of tracked files */
  diff: string;
  /** New files that are not committed yet */
  untracked: Array<{ path: string; content: string | null }>;
}

/** The per-file sections of a unified diff */
function splitDiffByFile(diff: string): Array<{ header: string; text: string }> {
  const sections: Array<{ header: string; text: string }> = [];
  for (const part of diff.split(/^(?=diff --git )/m)) {
    if (!part.trim()) continue;
    const header = /^diff --git a\/(.+?) b\/.+$/m.exec(part)?.[1] ?? part.split('\n', 1)[0];
    sections.push({ header, text: part.endsWith('\n') ? part : `${part}\n` });
  }
  return sections;
}

/**
 * The text of the review diff within `maxChars`. Whole files are kept in order until the budget is
 * used; files left out are named in a note, so the reviewer knows to read them with its tools.
 */
export function formatReviewDiff(parts: ReviewDiffParts, maxChars = MAX_REVIEW_DIFF_CHARS): string {
  const out: string[] = [];
  const omitted: string[] = [];
  let used = 0;

  for (const section of splitDiffByFile(parts.diff)) {
    if (used + section.text.length <= maxChars) {
      out.push(section.text);
      used += section.text.length;
    } else {
      omitted.push(section.header);
    }
  }
  for (const file of parts.untracked) {
    if (file.content === null) {
      out.push(`New file (binary or unreadable, not shown): ${file.path}\n`);
      continue;
    }
    const shown = file.content.length > MAX_UNTRACKED_FILE_CHARS
      ? `${file.content.slice(0, MAX_UNTRACKED_FILE_CHARS)}\n… (cut, ${file.content.length - MAX_UNTRACKED_FILE_CHARS} more characters)`
      : file.content;
    const text = `New file ${file.path}:\n${shown}\n`;
    if (used + text.length <= maxChars) {
      out.push(text);
      used += text.length;
    } else {
      omitted.push(file.path);
    }
  }

  const notes: string[] = [];
  if (parts.stat.trim()) notes.push(`Summary of the change:\n${parts.stat.trim()}`);
  if (omitted.length > 0) {
    notes.push(`The diff was cut to fit. These files are not shown, read them with your tools if they matter: ${omitted.join(', ')}`);
  }
  return [...notes, ...out].join('\n\n');
}

/**
 * Collect the task's changes against its base: committed work (since the merge base), uncommitted
 * edits and new files. Returns undefined when there is nothing to review.
 */
export async function collectReviewDiff(cwd: string, baseBranch: string): Promise<string | undefined> {
  const excludes = buildReviewExcludes(['.workbench']);
  let base = baseBranch;
  try {
    base = (await git(['merge-base', baseBranch, 'HEAD'], { cwd })).stdout.trim() || baseBranch;
  } catch {
    // Base ref unknown here: diff against it directly and let git say so
  }
  const [diff, stat, untrackedList] = await Promise.all([
    git(['diff', '--no-color', '--no-ext-diff', base, '--', '.', ...excludes], { cwd }),
    git(['diff', '--stat', '--no-color', base, '--', '.', ...excludes], { cwd }),
    git(['ls-files', '--others', '--exclude-standard', '--', '.', ...excludes], { cwd }),
  ]);
  const untracked: ReviewDiffParts['untracked'] = [];
  for (const file of untrackedList.stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 50)) {
    try {
      const content = await readFile(path.join(cwd, file), 'utf-8');
      untracked.push({ path: file, content: content.includes('\0') ? null : content });
    } catch {
      untracked.push({ path: file, content: null });
    }
  }
  if (!diff.stdout.trim() && untracked.length === 0) return undefined;
  return formatReviewDiff({ stat: stat.stdout, diff: diff.stdout, untracked });
}

// =============================================================================
// Findings
// =============================================================================

export type ReviewSeverity = 'blocker' | 'major' | 'minor';

export interface ReviewFinding {
  requiresHuman?: boolean;
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  issue: string;
  fix?: string;
}

export interface ReviewReport {
  findings: ReviewFinding[];
  summary: string;
}

/** Also used by validation: the finding itself is the human action card's source. */
export const HUMAN_REVIEW_FINDING_DESCRIPTION = 'For requiresHuman findings, write a self-contained, plain-language decision brief: requested action, concrete evidence and limits, supported recommendation or options, and exactly what accepting would authorize or leave unresolved. Explain row IDs/acronyms; file references supplement the brief.';

/** Keep the decision readable in the existing report, without another model phase. */
export const HUMAN_REVIEW_HANDOFF_PROMPT = `For each requiresHuman finding, write a short, self-contained decision brief in the finding text (issue for diff review, description for validation). Lead with the exact decision or action requested. Explain what was checked, the concrete result and important uncertainty, the evidence-supported recommendation or meaningful options, and exactly what acceptance would authorize and leave unresolved. If the evidence supports no recommendation, say so rather than inventing one. For a requested observation, say what the person should inspect or do and what to report.
Use plain language and short sentences, roughly 80-150 words or fewer. Explain technical labels and acceptance-row IDs in ordinary words. File/line references are supporting detail: the person must understand the request without opening a long audit or translating spec codes. Never submit only "needs human review", "owner sign-off required", blank confirmation fields, or a pointer to a report. Keep detailed hashes, statistics and provenance in linked evidence. Keep ordinary evidence/prose cleanup as agent-actionable work, not a human approval chore; preserve explicit restrictions on editing frozen evidence. Preserve uncertain, contradicted and out-of-scope results, and never invent approval.`;

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          issue: { type: 'string', description: HUMAN_REVIEW_FINDING_DESCRIPTION },
          requiresHuman: { type: 'boolean' },
          fix: { type: 'string' },
        },
        required: ['severity', 'issue'],
      },
    },
    summary: { type: 'string', description: 'One or two sentences: is the change correct and complete?' },
  },
  required: ['findings', 'summary'],
};

/** A review report from the model's structured output; unusable entries are dropped */
export function normalizeReview(raw: unknown, fallbackText = ''): ReviewReport {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const findings: ReviewFinding[] = [];
  if (Array.isArray(record.findings)) {
    for (const item of record.findings) {
      const f = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      if (typeof f.issue !== 'string' || !f.issue.trim()) continue;
      findings.push({
        severity: f.severity === 'blocker' || f.severity === 'major' ? f.severity : 'minor',
        issue: f.issue.trim(),
        ...(f.requiresHuman === true ? { requiresHuman: true } : {}),
        ...(typeof f.file === 'string' && f.file ? { file: f.file } : {}),
        ...(typeof f.line === 'number' && Number.isFinite(f.line) ? { line: f.line } : {}),
        ...(typeof f.fix === 'string' && f.fix.trim() ? { fix: f.fix.trim() } : {}),
      });
    }
  }
  const summary = typeof record.summary === 'string' && record.summary.trim() ? record.summary.trim() : fallbackText.trim();
  return { findings, summary };
}

export function countFindings(findings: readonly ReviewFinding[]): Record<ReviewSeverity, number> {
  const counts: Record<ReviewSeverity, number> = { blocker: 0, major: 0, minor: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}

/** Shared by fresh reviewers and validation, including resumed task sessions. */
export const TASK_REVIEW_SCOPE_PROMPT = `Judge this task's change, not completion of the entire project. Before reporting a missing requirement, identify the current task acceptance criterion or explicit applicable prerequisite for merging this change, and cite its task/spec/instruction source. Inspect that source when applicability is unclear; do not assume every project gate applies to every ticket.
An outstanding project/release acceptance gate owned by another task belongs in the summary as pending context, not a new blocking finding, unless it is also required for this task or explicitly required before this change may merge. For example, correcting a report does not itself require executing a separately owned playtest; a task to execute that playtest still requires actual participant evidence. Preserve explicit applicable project/spec requirements and recorded human decisions within their stated scope.
When related-spec human decisions are supplied, compare the actual named requirement, source task, artifacts and recorded words before demanding another decision. Do not recreate the same waived or deferred human activity merely by labeling it slice-wide, spec-level, or a new ticket. Reconcile documentation with the existing scoped disposition; distinguish that requirement's disposition from whole-spec acceptance. A genuinely different requirement or later revision outside the recorded scope stays pending, and a waived study remains unexecuted. Related-task evidence is not an inherited task-wide override.
Ordinary human review or permission to merge is a delivery step, not by itself a missing test or implementation defect. Never claim that out-of-scope work was completed, approved, waived or fixed.`;

/** The validate prompt's section about the review */
export function formatReviewForValidation(report: ReviewReport): string {
  if (report.findings.length === 0) {
    return `A separate reviewer with fresh context read the diff and found no issues${report.summary ? ` (${report.summary})` : ''}. You don't need to review the diff again.`;
  }
  const lines = report.findings.map((f, i) => {
    const where = f.file ? ` [${f.file}${f.line ? `:${f.line}` : ''}]` : '';
    return `${i + 1}. ${f.severity.toUpperCase()}${where}: ${f.issue}${f.requiresHuman ? ' [requiresHuman: true — verify task applicability; applicable human requirements remain pending until actual evidence or a scoped owner decision exists]' : ''}${f.fix ? ` Suggested fix: ${f.fix}` : ''}`;
  });
  return `A separate reviewer with fresh context read the diff and found:\n${lines.join('\n')}\n\nReviewer summary: ${report.summary || '(none)'}\nCheck each blocker and major finding against the code and this task's requirements: fix the ones that are real, and skip any that are mistaken or outside this task's scope, explaining why in the summary. A skipped external requirement stays pending; do not label it fixed or infer approval. Minor findings are optional.`;
}

export const REVIEW_SYSTEM_PROMPT = `You are a code reviewer with fresh eyes. You see the task, the diff of the change made for it, and any recorded human decisions supplied with them; you did not write it.
Look for real problems: bugs, missed requirements from the task, broken edge cases, security issues, and changes that break other code. Use your read, grep and glob tools to read the code around the changes and the code that uses them before you report a problem; do not report guesses.
${TASK_REVIEW_SCOPE_PROMPT}
Flag requiresHuman: true when an applicable unmet task requirement needs real human approval, a decision or participant observations. Keep it open unless an actual scoped human decision resolves it; an agent cannot fabricate that evidence.
${HUMAN_REVIEW_HANDOFF_PROMPT}
Do not report style, naming, formatting or missing nice-to-haves. Do not modify any file.
Severity: blocker = the change is broken or misses a core requirement; major = a real bug or gap that should be fixed before merging; minor = small and optional.
Report at most 12 findings, most important first, each with the file and line when you know them. An empty findings list is the right answer for a correct change.`;
