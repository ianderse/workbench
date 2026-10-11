
/**
 * All execution phases in order of progression.
 * Order matters for regression detection.
 *
 * 'idle' is frontend-only (initial state before any backend events)
 * 'rate_limit_paused' and 'auth_failure_paused' are pause states that
 * can occur during coding and will resume to coding when resolved.
 */
const EXECUTION_PHASES = [
  'idle',
  'planning',
  'coding',
  'rate_limit_paused',
  'auth_failure_paused',
  'qa_review',
  'qa_fixing',
  'complete',
  'failed'
] as const;
// Types derived from constants (single source of truth)
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];
/**
 * Phases that can be completed and tracked in completedPhases array.
 * Excludes 'idle', 'complete', and 'failed' which are not completable workflow phases.
 */
export type CompletablePhase = 'planning' | 'coding' | 'qa_review' | 'qa_fixing';

