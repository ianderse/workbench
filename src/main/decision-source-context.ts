import path from 'path';
import { createHash } from 'crypto';
import type { Task, TaskDecision, TaskSourceDecision } from '../shared/types/task';

const MAX_ANCESTORS = 12;
const MAX_DECISIONS = 4;
const MAX_INLINE_DECISION_BYTES = 8_000;
const MAX_CONTEXT_BYTES = 24_000;
const safeId = (id: unknown): id is string => typeof id === 'string' && id.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface SourceDecisionContext {
  taskMetadataPath?: string;
  records: Array<{ decision: TaskSourceDecision; metadataPath: string; viaTaskId: string }>;
  unresolved: Array<{ taskId: string; metadataPath?: string; reason: string; snapshotFingerprint?: string; sourceFingerprint?: string }>;
}

function recordedDecision(value: TaskDecision | undefined): value is TaskDecision {
  return !!value && typeof value.text === 'string' && !!value.text.trim()
    && typeof value.at === 'string' && value.at.length <= 64 && Number.isFinite(Date.parse(value.at))
    && ['tickets', 'deferred', 'rejected'].includes(value.outcome);
}

function sameDecision(a: TaskSourceDecision, b: TaskSourceDecision): boolean {
  return a.taskId === b.taskId && a.projectId === b.projectId && a.text === b.text
    && a.at === b.at && a.outcome === b.outcome;
}

/** Resolve host records, never model summaries or follow-up suggestions, within one project. */
export function resolveSourceDecisionContext(
  task: Task, tasks: readonly Task[], projectId: string, specsRoot: string,
): SourceDecisionContext | undefined {
  if (!task.metadata?.followUpFrom && !task.metadata?.splitFrom && !task.metadata?.sourceDecision) return undefined;
  const context: SourceDecisionContext = { records: [], unresolved: [],
    ...(safeId(task.specId) ? { taskMetadataPath: path.join(specsRoot, task.specId, 'task_metadata.json') } : {}) };
  const byId = new Map(tasks.filter((entry) => entry.projectId === projectId).map((entry) => [entry.id, entry]));
  byId.set(task.id, task);
  const queue = [{ task, ancestors: [] as string[] }];
  const visited = new Set<string>();
  const decisions = new Set<string>();
  const unresolved = (taskId: string, reason: string, snapshot?: TaskSourceDecision, source?: TaskDecision) => {
    context.unresolved.push({ taskId, reason, ...(safeId(taskId) ? { metadataPath: path.join(specsRoot, taskId, 'task_metadata.json') } : {}),
      ...(snapshot ? { snapshotFingerprint: fingerprint(snapshot) } : {}), ...(source ? { sourceFingerprint: fingerprint(source) } : {}) });
  };
  while (queue.length && visited.size < MAX_ANCESTORS && context.records.length < MAX_DECISIONS) {
    const entry = queue.shift()!;
    const current = entry.task;
    if (current.projectId !== projectId || !safeId(current.id)) {
      unresolved(current.id, 'The ancestry record is outside this project or has an invalid identity.');
      continue;
    }
    if (entry.ancestors.includes(current.id)) { unresolved(current.id, 'The ancestry contains a cyclic reference.'); continue; }
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    const snapshot = current.metadata?.sourceDecision;
    const from = current.metadata?.followUpFrom;
    const decisionId = from?.item === 'decision' ? from.taskId : snapshot?.taskId;
    if (decisionId) {
      if (snapshot && snapshot.projectId !== projectId) {
        unresolved(decisionId, 'The saved source-decision snapshot belongs to another project.');
      } else if (!safeId(decisionId)) {
        unresolved(decisionId, 'The originating decision identity is invalid.');
      } else {
        const source = byId.get(decisionId);
        const canonical = source?.metadata?.decision;
        if (!source || !safeId(source.specId)) {
          unresolved(decisionId, 'The originating task could not be loaded; this does not establish that no owner decision exists.', snapshot);
        } else if (!recordedDecision(canonical)) {
          unresolved(decisionId, 'The source has no usable recorded decision.text/at. A suggestion or empty derived field is not an owner decision.', snapshot);
        } else if (canonical.outcome !== 'tickets' || !Array.isArray(canonical.ticketIds)
          || !canonical.ticketIds.every(safeId) || !canonical.ticketIds.includes(current.id)) {
          unresolved(decisionId, 'The current originating decision does not link this generated task; reconcile its disposition and lineage before relying on it.', snapshot, canonical);
        } else {
          const decision: TaskSourceDecision = { taskId: source.id, projectId, text: canonical.text, at: canonical.at, outcome: canonical.outcome };
          if (snapshot && !sameDecision(snapshot, decision)) {
            unresolved(decisionId, 'The saved decision snapshot conflicts with the current source. Read the source and reconcile the exact scope; do not infer approval or its absence.', snapshot, canonical);
          } else if (!decisions.has(decisionId)) {
            decisions.add(decisionId);
            context.records.push({ decision, metadataPath: path.join(specsRoot, source.specId, 'task_metadata.json'), viaTaskId: current.id });
          }
        }
      }
      // This link is the decision boundary. An unrelated earlier decision is not a replacement.
      continue;
    }
    const ancestors = [...new Set([current.metadata?.splitFrom, from?.taskId].filter((id): id is string => !!id))];
    for (const id of ancestors) {
      const source = byId.get(id);
      if (!source) unresolved(id, 'An ancestor could not be loaded; review the original lineage before concluding that a required decision is missing.');
      else queue.push({ task: source, ancestors: [...entry.ancestors, current.id] });
    }
  }
  if (queue.length) unresolved(task.id, 'Decision ancestry exceeded its bounded lookup; read the remaining source references when applicability is unresolved.');
  return context.records.length || context.unresolved.length ? context : undefined;
}

/** Exact evidence is inlined when bounded; larger records are referenced, never silently clipped. */
export function formatSourceDecisionContext(context: SourceDecisionContext | undefined, runtimePath: (value: string) => string = (value) => value): string {
  if (!context || (!context.records.length && !context.unresolved.length)) return '';
  const sections = [`## Originating recorded decisions
These host records are evidence of the person's recorded words, not a model suggestion or a new task-wide override. Apply each decision only within its stated revision, artifacts and scope; it does not waive code/test failures or authorize unrelated work.
Before claiming owner evidence is missing, inspect these originating records. Empty checkpoint metadata.human or humanWork fields alone do not establish absence from the source. The recorded time is decision time: do not invent a separate review-session date, named reviewer, or an owner statement of no requested changes. Missing or conflicting provenance remains unverified, not proof that a new approval is required.`];
  if (context.taskMetadataPath) sections.push(`Ancestry root: ${JSON.stringify(runtimePath(context.taskMetadataPath))}, metadata followUpFrom/splitFrom/sourceDecision.`);
  for (const record of context.records) {
    const { decision } = record;
    const source = JSON.stringify(runtimePath(record.metadataPath));
    const header = `Source decision: ${decision.taskId}\nProject: ${decision.projectId}\nGenerated task: ${record.viaTaskId}\nRecorded decision time: ${decision.at}\nRecorded outcome: ${decision.outcome} (workflow disposition; interpret the person's words within their actual scope)\nDecision SHA-256: ${fingerprint(decision)}\nSource: ${source}, JSON fields decision.text, decision.at and decision.ticketIds.`;
    const inline = `${header}\nExact recorded words (verbatim):\n${decision.text}`;
    const canInline = Buffer.byteLength(decision.text, 'utf8') <= MAX_INLINE_DECISION_BYTES
      && Buffer.byteLength([...sections, inline].join('\n\n'), 'utf8') <= MAX_CONTEXT_BYTES;
    sections.push(canInline ? inline : `${header}\nFull decision text is referenced: read decision.text before judging applicability or requesting another owner response. A reference alone does not establish approval.`);
  }
  for (const issue of context.unresolved) {
    const location = issue.metadataPath ? ` Read ${JSON.stringify(runtimePath(issue.metadataPath))}, especially decision.text/at/ticketIds.` : '';
    const snapshot = issue.snapshotFingerprint ? ` Unverified snapshot SHA-256: ${issue.snapshotFingerprint}.` : '';
    const source = issue.sourceFingerprint ? ` Current source SHA-256: ${issue.sourceFingerprint}.` : '';
    const section = `Unverified decision provenance for ${safeId(issue.taskId) ? issue.taskId : '(invalid identity)'}: ${issue.reason}${location}${snapshot}${source}`;
    if (Buffer.byteLength([...sections, section].join('\n\n'), 'utf8') > MAX_CONTEXT_BYTES - 256) {
      sections.push(`Additional unresolved lineage is referenced through the ancestry root above; inspect it before judging missing evidence. Full context SHA-256: ${fingerprint(context)}.`);
      break;
    }
    sections.push(section);
  }
  return sections.join('\n\n');
}
