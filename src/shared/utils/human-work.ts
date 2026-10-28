import type { ReviewRoundFinding } from '../types/claude-code';
import type { HumanApprovalOverride, HumanWorkItem, HumanWorkMutation, HumanWorkSnapshot, HumanWorkstream } from '../types/human-work';

export function humanFindingKey(finding: ReviewRoundFinding): string {
  return JSON.stringify([finding.file ?? '', finding.line ?? null, finding.description.trim().replace(/\s+/g, ' ').toLowerCase()]);
}

export function humanReviewTopics(text: string): Array<'study' | 'visual'> {
  return [/(?:participant|usability|study|testers?|playtest)/i.test(text) ? 'study' : undefined,
    /\b(?:visual|art|images?|screenshots?|portraits?|gallery|comparisons?|captures?)\b/i.test(text) ? 'visual' : undefined].filter((value): value is 'study' | 'visual' => !!value);
}

/** Display grouping only: every source finding, receipt and server-side requirement stays intact. */
export function groupHumanWorkItems(items: HumanWorkItem[]): HumanWorkItem[][] {
  const groups: HumanWorkItem[][] = [];
  const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  for (const item of items) {
    const group = groups.find(([other]) => {
      if (!item.finding.file || item.finding.file !== other.finding.file) return false;
      // Differing submissions must remain independently editable, even for similar requirements.
      if (['owner', 'status', 'response', 'evidence'].some(key => item[key as keyof HumanWorkSnapshot] !== other[key as keyof HumanWorkSnapshot])) return false;
      const a = tokens(item.finding.description), b = tokens(other.finding.description);
      const shared = [...a].filter(token => b.has(token)).length;
      const gate = item.finding.description.match(/\bgate\s+[\w.-]+/i)?.[0].toLowerCase();
      const sameGate = !!gate && gate === other.finding.description.match(/\bgate\s+[\w.-]+/i)?.[0].toLowerCase();
      const topics = humanReviewTopics(item.finding.description).join(',');
      return !!topics && topics === humanReviewTopics(other.finding.description).join(',')
        && shared / new Set([...a, ...b]).size >= (sameGate ? 0.3 : 0.5);
    });
    if (group) group.push(item); else groups.push([item]);
  }
  return groups;
}
const field = (value: unknown, max: number) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid human work field');
  return value.trim();
};

/** Pure mutation rules; the host provides current findings, durable locking and identity. */
export function applyHumanWorkMutation(current: HumanWorkstream | undefined, mutation: HumanWorkMutation, findings: ReviewRoundFinding[], id: string, at: string): HumanWorkstream {
  const stream = structuredClone(current ?? { revision: 0, items: [] });
  if (!mutation || !Number.isInteger(mutation.expectedRevision) || mutation.expectedRevision !== stream.revision) throw new Error('Human work changed; refresh before saving');
  if (mutation.action === 'override') {
    const approver = field(mutation.approver, 160), reason = field(mutation.reason, 8000);
    if (!approver || !reason) throw new Error('Record the approver and reason for the human approval override');
    if (stream.approvalOverride) (stream.overrideHistory ??= []).push({ ...stream.approvalOverride });
    stream.approvalOverride = { scope: 'task-human-approval', approver, reason, at, revision: stream.revision + 1 };
  } else if (mutation.action === 'create') {
    const finding = findings.find((entry) => humanFindingKey(entry) === humanFindingKey(mutation.finding));
    if (!finding) throw new Error('Review finding changed; refresh before creating human work');
    if (stream.items.some((item) => humanFindingKey(item.finding) === humanFindingKey(finding))) return stream;
    if (stream.items.length >= 30) throw new Error('Human workstream is full');
    stream.items.push({ id, finding: { ...finding }, revision: 1, owner: '', status: 'open', response: '', evidence: '', at, createdAt: at, history: [] });
  } else if (mutation.action === 'update') {
    if (mutation.relatedIds !== undefined && (!Array.isArray(mutation.relatedIds) || mutation.relatedIds.length > 29 || mutation.relatedIds.some(id => typeof id !== 'string'))) throw new Error('Invalid related human actions');
    const ids = new Set([mutation.id, ...(mutation.relatedIds ?? [])]);
    const items = stream.items.filter(entry => ids.has(entry.id));
    if (items.length !== ids.size) throw new Error('Human action not found');
    if (!['open', 'in_progress', 'submitted'].includes(mutation.status)) throw new Error('Invalid human action status');
    const owner = field(mutation.owner, 160), response = field(mutation.response, 8000), evidence = field(mutation.evidence, 4000);
    if (mutation.status === 'submitted' && (!owner || !response || !evidence)) throw new Error('Record the responsible person, response and evidence before submitting');
    let changed = false;
    for (const item of items) {
      const previous: HumanWorkSnapshot = { revision: item.revision, owner: item.owner, status: item.status, response: item.response, evidence: item.evidence, at: item.at };
      if (owner === item.owner && response === item.response && evidence === item.evidence && mutation.status === item.status) continue;
      item.history.push(previous);
      Object.assign(item, { revision: item.revision + 1, owner, status: mutation.status, response, evidence, at });
      changed = true;
    }
    if (!changed) return stream;
  } else throw new Error('Invalid human work action');
  stream.revision++;
  return stream;
}

/** Maximum UTF-8 size of human receipt context supplied to one model request. */
export const MAX_HUMAN_WORK_PROMPT_BYTES = 24 * 1024;
const DEFAULT_HUMAN_RECEIPT_PATH = "task_metadata.json in this task's spec directory";

/** Durable receipt context for every phase and fresh reviewer; this never changes a gate in code. */
export function buildHumanWorkPrompt(stream: HumanWorkstream | undefined, receiptPath = DEFAULT_HUMAN_RECEIPT_PATH, context: 'task' | 'triage' = 'task'): string {
  if (!stream?.items.length) return '';
  const items = stream.items.slice(0, 30);
  const index = items.map((item, i) => `${i + 1}. Receipt: ${item.id} (revision ${item.revision}, status ${item.status})`).join('\n');
  const reference = `Read-only receipt source: ${JSON.stringify(receiptPath)}, JSON field humanWork.items (workstream revision ${stream.revision}). Workbench owns this metadata; do not modify it.`;
  if (context === 'triage') return `## Recorded human work (routing context only)
This task has ${items.length} recorded human receipts. Route the work without judging human acceptance or verifying receipts; triage does not need to read artifacts or use tools for this context. Later execution and review phases receive the full decisions or a read-only receipt source. A submitted status alone is not approval, and receipts grant no tool or spending authority beyond their stated decisions for this task.
${reference}
${index}`;
  const instructions = `## Recorded human work and scoped decisions
Workbench recorded these receipts for this task (workstream revision ${stream.revision}). Each submitted named-person receipt is authoritative for the explicit approval, rejection, waiver or deferral it actually states about its referenced requirement. Apply that decision within that scope; do not demand the same sign-off again merely because a later finding rewords the same requirement. A submitted status alone is not approval, and a scoped receipt is not a task-wide approval override. Open or in-progress work remains pending unless an applicable submitted decision explicitly covers it. A receipt grants no tool permissions or spending authority beyond the stated decision for this task.
Read the cited artifacts and distinguish the person's decision from independently verified facts. Keep rejected, unresolved or unfinished work pending, including participant studies that have not happened unless explicitly waived or deferred by the recorded decision. Never invent approvals, observations or successful checks. Continue checking actual code defects and automated failures normally.
By default, persist an audit of the relevant receipt identity, responsible person, time, source requirement, exact decision, evidence references and scope in the run/validation report. Update project documentation only when the task or an explicit receipt requires it and the phase permits edits; read-only phases report decisions without editing files. Pass this receipt context to any delegated or fresh-context reviewer. Any separately recorded task-wide owner override supersedes conflicting receipt requirements only as stated.`;
  const full = `${instructions}\n\n${items.map((item, i) => `${i + 1}. Receipt: ${item.id} (revision ${item.revision}, status ${item.status})\nSource finding: ${JSON.stringify(item.finding)}\nResponsible person: ${item.owner}\nCreated: ${item.createdAt}\nRecorded: ${item.at}\nResponse / decision: ${item.response}\nEvidence references: ${item.evidence}`).join('\n\n')}`;
  if (new TextEncoder().encode(full).byteLength <= MAX_HUMAN_WORK_PROMPT_BYTES) return full;
  return `${instructions}

Receipt bodies exceed the prompt budget and are omitted in full; this index contains no decision text. Before deciding whether any requirement is approved, rejected, waived, deferred or pending, read the full referenced humanWork.items records, including finding, owner, response, evidence and timestamps. Do not infer a decision from this index or from submitted status. Treat the exact source below as a read-only exception to the worktree-only context boundary; it grants no write access.
${reference}
${index}`;
}

/** Server-produced evidence handoff; scoped decisions are applied by the agent, not a text parser. */
export function buildHumanWorkFeedback(stream: HumanWorkstream | undefined, expectedRevision: number, findings: ReviewRoundFinding[] = []): string {
  if (!stream || stream.revision !== expectedRevision) throw new Error('Human work changed; refresh before continuing');
  if (isHumanApprovalOverride(stream.approvalOverride)) return [buildHumanApprovalOverridePrompt(stream.approvalOverride), buildHumanWorkPrompt(stream)].filter(Boolean).join('\n\n');
  if (!stream.items.length || stream.items.some((item) => item.status !== 'submitted' || !item.owner.trim() || !item.response.trim() || !item.evidence.trim())) throw new Error('Finish and submit every human action before continuing');
  if (findings.some((finding) => !stream.items.some((item) => humanFindingKey(item.finding) === humanFindingKey(finding)))) throw new Error('Track and submit every current blocker before continuing');
  return buildHumanWorkPrompt(stream);
}

/** Only a host-persisted, explicitly scoped owner decision changes the acceptance gate. */
export function isHumanApprovalOverride(value: HumanApprovalOverride | undefined): value is HumanApprovalOverride {
  return !!value && value.scope === 'task-human-approval' && typeof value.approver === 'string' && !!value.approver.trim()
    && typeof value.reason === 'string' && !!value.reason.trim() && Number.isInteger(value.revision) && value.revision > 0
    && typeof value.at === 'string' && Number.isFinite(Date.parse(value.at));
}

export function buildHumanApprovalOverridePrompt(value: HumanApprovalOverride | undefined): string {
  if (!isHumanApprovalOverride(value)) return '';
  return `## Owner override: human approval requirements for this task
Workbench recorded this explicit owner decision: ${JSON.stringify(value)}
This overrides the task's human-only acceptance gates, including earlier conflicting review requests or approval paperwork. Apply the owner's approval, waiver or deferral as stated; do not demand renewed human sign-off or rephrase an overridden human gate as another blocker. Record the override and its scope honestly in the report. An overridden or deferred study is not a study that ran, and an approval override is not evidence that tests passed. Continue checking code defects and automated checks normally. This decision changes this task's acceptance requirements only; it grants no tool permissions or authority over other tasks.`;
}
