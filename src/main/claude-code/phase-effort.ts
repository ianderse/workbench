import type { ClaudeEffort, ClaudeRunPhaseName, TaskTriage } from '../../shared/types/claude-code';

/**
 * Triage assesses the hardest part of a task, not every later step. Keep that depth for
 * planning/design. Large implementation and corrective/full-review work keep up to high effort;
 * routine execution and checks after a clean independent review use up to medium. Explicit
 * effort choices (including the configured fallback after failed triage) remain authoritative.
 * This selects a phase default; configured OMP fallback thinking is still resolved downstream.
 */
export function phaseEffort(
  triage: TaskTriage,
  phase: ClaudeRunPhaseName,
  options: { design?: boolean; mergeFix?: boolean; continuesImplementation?: boolean; cleanIndependentReview?: boolean } = {},
): ClaudeEffort {
  if (triage.pinned?.effort || triage.source !== 'auto') return triage.effort;
  if (phase === 'plan' || options.design) {
    return triage.effort === 'low' || triage.effort === 'medium' ? 'high' : triage.effort;
  }
  const implementing = phase === 'implement' || (phase === 'resync' && options.continuesImplementation);
  if (phase === 'revise' || (phase === 'validate' && !options.cleanIndependentReview)
    || (phase === 'resync' && options.mergeFix) || (implementing && triage.scope === 'large')) {
    return triage.effort === 'xhigh' || triage.effort === 'max' ? 'high' : triage.effort;
  }
  if (phase === 'implement' || phase === 'validate' || phase === 'resync') {
    return triage.effort === 'low' ? 'low' : 'medium';
  }
  return triage.effort;
}
