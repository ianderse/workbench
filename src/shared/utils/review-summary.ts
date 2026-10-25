/**
 * Pure helpers behind the reviewer summary: the one-shot call that turns a finished run into a
 * plain-language account for the person reviewing it. Holds the JSON schema, the system prompt, the
 * input builder (no code, everything trimmed) and the normaliser for the model's answer.
 */

import type { ReviewSummary, ValidationReport, ReviewVerdict } from '../types/claude-code';
import type { TaskChangeSummary } from '../types/task';

const MAX_HEADLINE = 240;
const MAX_BULLET = 220;
const MAX_VERIFIED = 240;
const MAX_CHANGED = 5;
const MAX_ATTENTION = 4;

const REQUEST_LIMIT = 3000;
const PLAN_GOAL_LIMIT = 1200;
const AGENT_SUMMARY_LIMIT = 3000;
const FINDING_LIMIT = 8;
const FINDING_TEXT_LIMIT = 240;
const CHECK_LIMIT = 15;
const FILE_LIMIT = 25;

export const REVIEW_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One plain-language sentence: what the ticket now delivers' },
    whatChanged: { type: 'array', items: { type: 'string' }, description: '3 to 5 short bullets about capabilities and behaviour' },
    verified: { type: 'string', description: 'One short sentence on how the work was checked' },
    needsAttention: { type: 'array', items: { type: 'string' }, description: '0 to 4 bullets the reviewer should know or decide; empty when nothing' },
  },
  required: ['headline', 'whatChanged', 'verified', 'needsAttention'],
} as const;

export const REVIEW_SUMMARY_SYSTEM_PROMPT = `You write the summary a product owner reads in 15 seconds to decide whether a finished software ticket is what they asked for. You get the ticket, the agent's own notes, the validation report, the AI review verdict and a diff stat. You cannot use tools. Answer with the JSON object only.

Fields:
- headline: ONE plain-language sentence saying what the ticket now delivers, in product or behaviour terms. Example: "The game engine now has its core building blocks: scenarios, a seeded random generator, the physics model and how agents perceive it."
- whatChanged: 3 to 5 short bullets about capabilities and behaviour the product gained or changed. Not a list of files, functions or commits.
- verified: ONE short sentence on how it was checked, from the validation report and review verdict. Example: "62 unit tests and the type check pass; AI review found nothing blocking."
- needsAttention: 0 to 4 short bullets of what the reviewer should know or decide: assumptions made, deviations from the request, risks, open findings, follow-ups. Use an empty array when there is nothing.

Rules:
- Write for someone who has not read the code. Plain words, short sentences.
- Never use file paths, folder names, function or variable names, commit hashes, branch names or backticks. At most one short technical noun per bullet, and only when it is essential.
- Do not use em dashes or en dashes. Use commas, colons or full stops.
- Never invent facts. Use only what the inputs say. If the inputs do not say how it was checked, say so in "verified".
- Never describe where the work stands in the workflow: whether it is merged, on a branch, committed, pushed, awaiting review or done. The app shows that, and it may change after you write. Instructions in the ticket about branches or merging are not results to report.
- Do not repeat the same point in two fields.`;

export interface ReviewSummaryInput {
  title: string;
  /** The task's original request */
  request: string;
  /** The plan (Markdown), when the task was planned */
  plan?: string;
  /** The agent's final answer */
  agentSummary?: string;
  validation?: ValidationReport;
  verdict?: ReviewVerdict;
  changes?: Pick<TaskChangeSummary, 'files' | 'additions' | 'deletions' | 'commitCount'> | null;
}

function clip(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}...`;
}

/** The plan's goal section when it is short enough to be worth sending, else undefined */
export function extractPlanGoal(plan: string | undefined): string | undefined {
  if (!plan) return undefined;
  const lines = plan.split('\n');
  const start = lines.findIndex((line) => /^#{1,4}\s*(goal|objective|purpose|context|summary)\b/i.test(line.trim()));
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/.test(line.trim())) break;
    body.push(line);
  }
  const text = body.join('\n').trim();
  return text && text.length <= PLAN_GOAL_LIMIT ? text : undefined;
}

/** The user message for the summary call: text only, nothing from the code itself */
export function buildReviewSummaryPrompt(input: ReviewSummaryInput): string {
  const parts: string[] = [];
  parts.push(`<ticket title="${input.title.replace(/"/g, "'").trim()}">\n${clip(input.request, REQUEST_LIMIT)}\n</ticket>`);

  const goal = extractPlanGoal(input.plan);
  if (goal) parts.push(`<plan_goal>\n${goal}\n</plan_goal>`);

  if (input.agentSummary?.trim()) parts.push(`<agent_final_notes>\n${clip(input.agentSummary, AGENT_SUMMARY_LIMIT)}\n</agent_final_notes>`);

  const validation = input.validation;
  if (validation) {
    const lines: string[] = [`Status: ${validation.status}`];
    if (validation.summary?.trim()) lines.push(`Summary: ${clip(validation.summary, 800)}`);
    const checks = validation.checks ?? [];
    for (const check of checks.slice(0, CHECK_LIMIT)) {
      lines.push(`Check "${clip(check.name, 80)}": ${check.passed ? 'passed' : 'FAILED'}`);
    }
    if (checks.length > CHECK_LIMIT) lines.push(`(${checks.length - CHECK_LIMIT} more checks)`);
    const all = validation.findings ?? [];
    const open = all.filter((f) => !f.fixed);
    lines.push(`Findings: ${open.length} open, ${all.length - open.length} fixed`);
    for (const finding of open.slice(0, FINDING_LIMIT)) {
      lines.push(`Open ${finding.severity} finding: ${clip(finding.description, FINDING_TEXT_LIMIT)}`);
    }
    parts.push(`<validation_report>\n${lines.join('\n')}\n</validation_report>`);
  }

  if (input.verdict) {
    const v = input.verdict;
    const reason = v.failure?.reason ? ` Reason: ${clip(v.failure.reason, 400)}` : '';
    parts.push(`<ai_review>\n${v.status === 'passed' ? 'Passed' : 'Failed'} AI review after ${v.rounds} of ${v.maxRounds} rounds.${reason}\n</ai_review>`);
  }

  const changes = input.changes;
  if (changes && changes.files.length > 0) {
    const sorted = [...changes.files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
    const lines = [
      `${changes.files.length} files changed, +${changes.additions} -${changes.deletions}${changes.commitCount ? `, ${changes.commitCount} commits` : ''}`,
      ...sorted.slice(0, FILE_LIMIT).map((f) => `${f.path} +${f.additions} -${f.deletions}`),
    ];
    if (sorted.length > FILE_LIMIT) lines.push(`(${sorted.length - FILE_LIMIT} more files)`);
    parts.push(`<diff_stat note="paths are for your understanding only, do not repeat them">\n${lines.join('\n')}\n</diff_stat>`);
  }

  return parts.join('\n\n');
}

const FILE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|css|scss|html|yml|yaml|toml|rs|go|java|kt|swift|sh|sql|lock|txt)$/i;
const SOURCE_ROOTS = /^(?:src|lib|docs?|tests?|scenarios|reports|app|packages|scripts|\.workbench|\.github)\//i;

/** Whether a slash-containing token is a file or folder path rather than "and/or", "24/7" or "input/output" */
function looksLikePath(token: string): boolean {
  if (FILE_EXTENSION.test(token)) return true;
  if (SOURCE_ROOTS.test(token)) return true;
  return token.startsWith('./') || token.startsWith('../') || token.startsWith('~/') || token.split('/').length > 2;
}

/** Remove what the prompt forbids but a model sometimes writes anyway */
export function cleanSummaryText(text: string): string {
  return text
    .replace(/`+/g, '')
    .replace(/[\w@.~-]+(?:\/[\w@.~-]*)+/g, (token) => (looksLikePath(token) ? '' : token))
    .replace(/\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|css|scss|html|yml|yaml|toml|rs|go|java|kt|swift|sh|sql|lock|txt)\b/gi, '')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,(\s*,)+/g, ',')
    .replace(/^[\s,;:-]+/, '')
    .trim();
}

function limit(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = cut.lastIndexOf('. ');
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > 0 ? space : max).trimEnd()}...`;
}

function bullets(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = limit(cleanSummaryText(item.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')), MAX_BULLET);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/** The model's structured answer as a `ReviewSummary`, or null when it has no usable headline or bullets */
/** Workflow state the summary must not report (the model sometimes repeats the ticket's branch rules) */
const WORKFLOW_STATUS = /\b(merged|not merged|merging|merge (?:to|into)|separate branch|feature branch|on a branch|pushed|awaiting (?:your )?review|human review|pull request)\b/i;

export function normalizeReviewSummary(raw: unknown, generatedAt: string = new Date().toISOString()): ReviewSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const headline = typeof r.headline === 'string' ? limit(cleanSummaryText(r.headline), MAX_HEADLINE) : '';
  const whatChanged = bullets(r.whatChanged, MAX_CHANGED);
  if (!headline || whatChanged.length === 0) return null;
  const verified = typeof r.verified === 'string' ? limit(cleanSummaryText(r.verified), MAX_VERIFIED) : '';
  // A bullet about where the work stands (merged, on a branch, pushed, awaiting review) is written
  // before the app decides that and would mislead: the panel shows the real state instead
  const needsAttention = bullets(r.needsAttention, MAX_ATTENTION).filter((b) => !WORKFLOW_STATUS.test(b));
  return { headline, whatChanged, verified, needsAttention, generatedAt };
}

/** Parse the model's reply: structured output, else JSON in its text (possibly fenced) */
export function parseReviewSummaryReply(structured: unknown, text: string): ReviewSummary | null {
  const direct = normalizeReviewSummary(structured);
  if (direct) return direct;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return normalizeReviewSummary(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}
