import type { ReviewRoundFinding } from '../types/claude-code';
import type { HumanApprovalOverride, HumanWorkMutation, HumanWorkSnapshot, HumanWorkstream } from '../types/human-work';

export function humanFindingKey(finding: ReviewRoundFinding): string {
  return JSON.stringify([finding.file ?? '', finding.line ?? null, finding.description.trim().replace(/\s+/g, ' ').toLowerCase()]);
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
    const item = stream.items.find((entry) => entry.id === mutation.id);
    if (!item) throw new Error('Human action not found');
    if (!['open', 'in_progress', 'submitted'].includes(mutation.status)) throw new Error('Invalid human action status');
    const owner = field(mutation.owner, 160), response = field(mutation.response, 8000), evidence = field(mutation.evidence, 4000);
    if (mutation.status === 'submitted' && (!owner || !response || !evidence)) throw new Error('Record the responsible person, response and evidence before submitting');
    const previous: HumanWorkSnapshot = { revision: item.revision, owner: item.owner, status: item.status, response: item.response, evidence: item.evidence, at: item.at };
    if (owner === item.owner && response === item.response && evidence === item.evidence && mutation.status === item.status) return stream;
    item.history.push(previous);
    Object.assign(item, { revision: item.revision + 1, owner, status: mutation.status, response, evidence, at });
  } else throw new Error('Invalid human work action');
  stream.revision++;
  return stream;
}

/** Server-produced evidence handoff; submitting a receipt never changes the existing AI verdict. */
export function buildHumanWorkFeedback(stream: HumanWorkstream | undefined, expectedRevision: number, findings: ReviewRoundFinding[] = []): string {
  if (!stream || stream.revision !== expectedRevision) throw new Error('Human work changed; refresh before continuing');
  if (isHumanApprovalOverride(stream.approvalOverride)) return `${buildHumanApprovalOverridePrompt(stream.approvalOverride)}\n\nPrevious human work (historical context, superseded where the override conflicts):\n${JSON.stringify(stream.items.map(({ finding, owner, status, response, evidence, at }) => ({ finding, owner, status, response, evidence, at })))}`;
  if (!stream.items.length || stream.items.some((item) => item.status !== 'submitted' || !item.owner.trim() || !item.response.trim() || !item.evidence.trim())) throw new Error('Finish and submit every human action before continuing');
  if (findings.some((finding) => !stream.items.some((item) => humanFindingKey(item.finding) === humanFindingKey(finding)))) throw new Error('Track and submit every current blocker before continuing');
  return `The following human work was explicitly recorded in Workbench. These are named-person submissions, not independently verified facts. Read the cited artifacts, update the task's documentation from the supplied evidence, and rerun the relevant review. Keep unresolved or rejected requirements pending; do not fabricate approvals or participant observations. This handoff does not approve or waive any requirement.\n\n${stream.items.map((item, index) => `${index + 1}. Requirement: ${item.finding.description}\nSource: ${item.finding.file ?? '(review finding)'}${item.finding.line ? `:${item.finding.line}` : ''}\nResponsible person: ${item.owner}\nRecorded: ${item.at}\nResponse / decision: ${item.response}\nEvidence references: ${item.evidence}`).join('\n\n')}`;
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
