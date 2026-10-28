import { createHash } from 'crypto';
import type { PhaseProgressEvidence, PhaseProgressState } from '../../shared/types/task-throughput';

export type { PhaseProgressEvidence, PhaseProgressState } from '../../shared/types/task-throughput';

export interface PhaseProgressEvent {
  phaseKey: string;
  phase: string;
  completed: boolean;
  successful: boolean;
  numTurns: number;
  pendingWork?: boolean;
  providerFailure?: boolean;
  cooldown?: boolean;
  continued?: boolean;
  before?: PhaseProgressEvidence;
  after: PhaseProgressEvidence;
  at: string;
}
export interface PhaseProgressPolicy {
  minTurns?: number;
  warnAfter?: number;
  allowFreshContext?: boolean;
  allowFallback?: boolean;
  modelPinned?: boolean;
  fallbackAvailable?: boolean;
}
export type PhaseProgressAction = 'none' | 'warn' | 'fresh-context' | 'configured-fallback' | 'stalled';

function normalized(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean))].sort();
}
function evidence(value: PhaseProgressEvidence): PhaseProgressEvidence {
  return { repositoryFingerprint: value.repositoryFingerprint, failedChecks: normalized(value.failedChecks), openFindings: normalized(value.openFindings) };
}
function signature(value: PhaseProgressEvidence): string {
  return JSON.stringify([value.failedChecks, value.openFindings]);
}

/** Evaluates settled phases only. Streamed output, reads and tool activity are not progress evidence. */
export function evaluatePhaseProgress(previous: PhaseProgressState | undefined, event: PhaseProgressEvent, policy: PhaseProgressPolicy = {}): { state: PhaseProgressState; action: PhaseProgressAction; reason?: string } {
  const state: PhaseProgressState = structuredClone(previous ?? {
    version: 1, evaluatedPhaseKeys: [], consecutiveNoProgress: 0, freshContextRecoveries: 0, fallbackRecoveries: 0, updatedAt: event.at,
  });
  if (!event.completed || !event.successful || event.pendingWork || event.providerFailure || event.cooldown || state.evaluatedPhaseKeys.includes(event.phaseKey)) return { state, action: 'none' };
  const after = evidence(event.after);
  const before = event.before ? evidence(event.before) : state.lastEvidence;
  const priorValidation = state.lastValidationSignature;
  state.updatedAt = event.at;
  state.lastEvaluatedPhaseKey = event.phaseKey;
  state.evaluatedPhaseKeys.push(event.phaseKey);
  state.lastEvidence = after;
  const currentSignature = signature(after);
  if (event.phase === 'validate') state.lastValidationSignature = currentSignature;
  const repoChanged = !!before && before.repositoryFingerprint !== after.repositoryFingerprint;
  const checksImproved = !!before && before.failedChecks.some((check) => !after.failedChecks.includes(check));
  const findingsImproved = !!before && before.openFindings.some((finding) => !after.openFindings.includes(finding));
  const successfulReview = event.phase === 'validate' && after.failedChecks.length === 0 && after.openFindings.length === 0;
  if (repoChanged || checksImproved || findingsImproved || successfulReview) {
    state.consecutiveNoProgress = 0;
    state.escalationKey = undefined;
    return { state, action: 'none' };
  }
  const repeatedReview = event.phase === 'validate' && priorValidation !== undefined && priorValidation === currentSignature && (after.failedChecks.length > 0 || after.openFindings.length > 0);
  const longWork = (event.phase === 'implement' || event.phase === 'revise' || (event.phase === 'resync' && event.continued)) && event.numTurns >= (policy.minTurns ?? 10) && before !== undefined;
  if (!repeatedReview && !longWork) return { state, action: 'none' };
  state.consecutiveNoProgress++;
  const threshold = policy.warnAfter ?? 2;
  if (state.consecutiveNoProgress < threshold) return { state, action: 'none' };
  const digest = createHash('sha256').update(JSON.stringify([event.phaseKey, after, state.consecutiveNoProgress])).digest('hex');
  state.escalationKey = digest;
  if (state.consecutiveNoProgress === threshold) return { state, action: 'warn', reason: 'Repeated completed work has not changed repository state or improved validation evidence' };
  if (policy.allowFreshContext !== false && state.freshContextRecoveries === 0) {
    state.freshContextRecoveries++;
    return { state, action: 'fresh-context', reason: 'Continue once from a verified handoff instead of repeating the same context' };
  }
  if (policy.allowFallback === true && policy.modelPinned !== true && policy.fallbackAvailable === true && state.fallbackRecoveries === 0) {
    state.fallbackRecoveries++;
    return { state, action: 'configured-fallback', reason: 'The fresh-context recovery did not improve progress; try one authorized configured fallback' };
  }
  return { state, action: 'stalled', reason: 'Progress recovery is exhausted; preserve the current task and report the unchanged blockers' };
}
