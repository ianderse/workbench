import path from 'path';
import { createHash } from 'crypto';
import type { Task } from '../shared/types/task';
import type { HumanApprovalOverride, HumanWorkItem } from '../shared/types/human-work';
import { isHumanApprovalOverride } from '../shared/utils/human-work';

const MAX_LINEAGE = 12;
const MAX_RECORDS = 12;
const MAX_INLINE_BYTES = 8_000;
export const MAX_SPEC_HUMAN_DECISION_PROMPT_BYTES = 24_000;
const safeId = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const dated = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface SpecHumanDecisionRecord {
  taskId: string;
  metadataPath: string;
  title: string;
  description: string;
  matchedSpecs: string[];
  workstreamRevision: number;
  override?: HumanApprovalOverride;
  receipts: HumanWorkItem[];
  /** Current recorded requests, not a historical snapshot of what the override covered. */
  sourceFindings: Array<{ receiptId: string; revision: number; createdAt: string; at: string; finding: HumanWorkItem['finding'] }>;
}

export interface SpecHumanDecisionContext {
  specs: string[];
  taskMetadataPath?: string;
  records: SpecHumanDecisionRecord[];
  unresolved: Array<{ taskId: string; reason: string }>;
  omittedRecords: number;
  /** Covers every matching source record, including records referenced rather than inlined. */
  fingerprint: string;
  lookupUnavailable?: boolean;
}

function canonicalSpec(value: unknown, root: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\0\r\n]/.test(value) || !/\.mdx?$/i.test(value)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !path.isAbsolute(value)) return undefined;
  const relative = path.relative(root, path.resolve(root, value));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

function submittedReceipt(item: HumanWorkItem): boolean {
  return !!item && safeId(item.id) && item.status === 'submitted' && nonempty(item.owner)
    && nonempty(item.response) && nonempty(item.evidence) && dated(item.at)
    && Number.isInteger(item.revision) && item.revision > 0 && !!item.finding && nonempty(item.finding.description);
}

/** Canonical same-project spec overlap supplies evidence, never inherited acceptance authority. */
export function resolveSpecHumanDecisionContext(
  task: Task, tasks: readonly Task[], projectId: string, projectRoot: string, specsRoot: string,
): SpecHumanDecisionContext | undefined {
  if (task.projectId !== projectId || !safeId(task.id)) return undefined;
  const root = path.resolve(projectRoot);
  const projectTasks = tasks.filter((entry) => entry.projectId === projectId && safeId(entry.id));
  const byId = new Map(projectTasks.map((entry) => [entry.id, entry]));
  byId.set(task.id, task);
  const unresolved: SpecHumanDecisionContext['unresolved'] = [];
  const scopeOf = (start: Task, report: boolean): Set<string> => {
    const specs = new Set<string>();
    const queue = [start];
    const visited = new Set<string>();
    const note = (id: string, reason: string) => { if (report) unresolved.push({ taskId: id, reason }); };
    while (queue.length && visited.size < MAX_LINEAGE) {
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      const add = (sources: unknown) => {
        if (!Array.isArray(sources)) return;
        for (const source of sources) {
          const spec = canonicalSpec(source, root);
          if (spec) specs.add(spec);
          else note(current.id, 'A spec source is invalid or outside this project; its decision scope is unverified.');
        }
      };
      add(current.metadata?.specBatch?.source);
      const batchId = current.metadata?.specReview?.batchId;
      if (batchId) {
        const members = projectTasks.filter((entry) => entry.metadata?.specBatch?.id === batchId);
        if (!members.length) note(current.id, 'The spec review batch sources could not be loaded; this does not establish that no owner decision exists.');
        for (const member of members) add(member.metadata?.specBatch?.source);
      }
      for (const id of [current.metadata?.splitFrom, current.metadata?.followUpFrom?.taskId]) {
        if (!id) continue;
        const parent = safeId(id) ? byId.get(id) : undefined;
        if (parent) queue.push(parent);
        else note(current.id, 'A source task could not be loaded; inspect its lineage before judging absent owner evidence.');
      }
    }
    if (queue.length) note(start.id, 'Spec lineage exceeded its bounded lookup; inspect the source records when scope is unresolved.');
    return specs;
  };
  const specs = [...scopeOf(task, true)].sort();
  if (!specs.length && !unresolved.length) return undefined;
  const target = new Set(specs);
  const records: SpecHumanDecisionRecord[] = [];
  for (const source of projectTasks) {
    if (source.id === task.id || !safeId(source.specId)) continue;
    const stream = source.metadata?.humanWork;
    if (!stream) continue;
    const override = isHumanApprovalOverride(stream.approvalOverride) ? stream.approvalOverride : undefined;
    const items = Array.isArray(stream.items) ? stream.items : [];
    const receipts = items.filter(submittedReceipt);
    if (!override && !receipts.length) continue;
    const matchedSpecs = [...scopeOf(source, false)].filter((spec) => target.has(spec)).sort();
    if (!matchedSpecs.length) continue;
    records.push(structuredClone({
      taskId: source.id, metadataPath: path.join(specsRoot, source.specId, 'task_metadata.json'),
      title: source.title ?? '', description: source.metadata?.userDescription ?? source.description ?? '',
      matchedSpecs, workstreamRevision: stream.revision, ...(override ? { override } : {}), receipts,
      sourceFindings: override ? items.filter((item) => item?.finding && nonempty(item.finding.description))
        .map((item) => ({ receiptId: item.id, revision: item.revision, createdAt: item.createdAt, at: item.at, finding: item.finding })) : [],
    }));
  }
  // A bounded view must favor the latest source decisions, not the oldest ticket numbers.
  const latest = (record: SpecHumanDecisionRecord) => Math.max(record.override ? Date.parse(record.override.at) : 0,
    ...record.receipts.map((receipt) => Date.parse(receipt.at)));
  records.sort((a, b) => latest(b) - latest(a) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const fingerprint = digest({ specs, records, unresolved });
  return { specs, records: records.slice(0, MAX_RECORDS), unresolved,
    omittedRecords: Math.max(0, records.length - MAX_RECORDS), fingerprint,
    ...(safeId(task.specId) ? { taskMetadataPath: path.join(specsRoot, task.specId, 'task_metadata.json') } : {}),
  };
}

/** Bounded exact evidence or an explicit read-only reference; never silently clip a decision. */
export function formatSpecHumanDecisionContext(
  context: SpecHumanDecisionContext | undefined, runtimePath: (value: string) => string = (value) => value,
): string {
  if (!context) return '';
  const sections = [`## Recorded human decisions on related spec requirements
These same-project host records are evidence context, not an inherited task-wide override or overall spec acceptance. Apply the person's exact words only to the source task's actual requirements, artifacts and revision. Compare source descriptions and findings with the current requirement before judging applicability.
Task descriptions and source findings are current scope evidence, not immutable snapshots of the scope at decision time. Compare each request's createdAt, at and revision with the decision's time and stated scope. Do not extend an older decision to later or newly added requirements; missing dates or earlier receipt creation alone do not prove that the current wording was covered.
Do not demand the same human study or sign-off again merely by renaming an already covered requirement as a new ticket or a "slice-wide" gate. A task-scoped decision can establish disposition of that task's identified spec requirement without approving every requirement in the spec. Preserve distinct unmet requirements and later changed scope. Keep waived/deferred/not-executed separate from performed research, and never fabricate participants, observations, approval, or successful checks.
Before claiming owner evidence is absent, read the canonical sources below. A shared spec path alone does not grant acceptance or tool/spending authority. Missing, conflicting or unread records are unverified, not proof that another owner response is required.
Related source evidence SHA-256: ${context.fingerprint}`];
  const fits = (section: string) => Buffer.byteLength([...sections, section].join('\n\n'), 'utf8') <= MAX_SPEC_HUMAN_DECISION_PROMPT_BYTES - 512;
  if (context.taskMetadataPath) {
    const source = `Current scope source: ${JSON.stringify(runtimePath(context.taskMetadataPath))}, metadata.specBatch/specReview and split/follow-up lineage.`;
    if (fits(source)) sections.push(source);
  }
  const scope = `Matched canonical project spec paths: ${JSON.stringify(context.specs)}`;
  if (fits(scope)) sections.push(scope);
  else sections.push('The complete spec-path list is referenced through the current scope source; it is not clipped or assumed known.');
  if (context.lookupUnavailable) sections.push('Related project-task lookup was unavailable. Supplied records are incomplete; do not infer absence of an owner decision.');
  let omitted = context.omittedRecords;
  for (const record of context.records) {
    const header = `Source task: ${record.taskId}\nSource evidence SHA-256: ${digest(record)}\nRead-only source: ${JSON.stringify(runtimePath(record.metadataPath))}, metadata.userDescription and humanWork (including approvalOverride, items, revisions and timestamps). If userDescription is absent, read description/feature in ${JSON.stringify(runtimePath(path.join(path.dirname(record.metadataPath), 'implementation_plan.json')))} for the source task scope.`;
    const body = `Exact host-recorded scope and decisions:\n${JSON.stringify(record)}`;
    const inline = `${header}\n${body}`;
    const reference = `${header}\nFull scope/decision text is referenced rather than truncated. Read the exact source before judging applicability; do not infer approval or absent approval from this reference.`;
    const section = Buffer.byteLength(body, 'utf8') <= MAX_INLINE_BYTES && fits(inline) ? inline : reference;
    if (fits(section)) sections.push(section);
    else omitted++;
  }
  for (const issue of context.unresolved) {
    const section = `Unverified source scope for ${issue.taskId}: ${issue.reason}`;
    if (fits(section)) sections.push(section);
    else { omitted++; break; }
  }
  if (omitted) sections.push(`${omitted} additional related records/scope references omitted from this bounded view. Inspect same-project canonical task metadata for the matched spec paths; the source evidence fingerprint above covers every matched record.`);
  if (!context.records.length && !context.lookupUnavailable) sections.push('No matching usable decisions were present in the supplied task records. This bounded lookup is not proof that no owner decision exists.');
  return sections.join('\n\n');
}
