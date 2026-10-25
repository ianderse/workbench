/**
 * Retrying OMP phases
 * ===================
 *
 * A local model server that drops a connection or stalls should not fail a task that runs for
 * hours: the phase is resumed in the same OMP session after a pause. This module only decides
 * (pure functions): whether a failure is worth retrying and how long to wait.
 */

/** Pauses before retry 1, 2 and 3 of a phase */
export const OMP_RETRY_DELAYS_MS: readonly number[] = [30_000, 2 * 60_000, 5 * 60_000];

export const OMP_MAX_RETRIES = OMP_RETRY_DELAYS_MS.length;

/** Pause before the given retry (1-based), or undefined when the retries are used up */
export function ompRetryDelayMs(retry: number): number | undefined {
  return retry >= 1 ? OMP_RETRY_DELAYS_MS[retry - 1] : undefined;
}

/** Errors that will not go away by trying again: configuration, credentials, quota, bad requests */
const PERMANENT_PATTERNS: RegExp[] = [
  /credit_balance_exhausted|credit balance|insufficient[_ ](?:credit|funds|quota)|billing/i,
  /quota (?:exceeded|exhausted)|usage[_ ]limit[_ ]reached|usage limit has been reached|out of credits/i,
  /built-in tool unavailable/i,
  /model[^\n]{0,40}not found|unknown model|no such model|model_not_found/i,
  /unknown (?:option|flag|argument)|unrecognized (?:option|argument)|invalid (?:argument|option|flag)/i,
  /\b40[13]\b|unauthori[sz]ed|forbidden|invalid api key|authentication|permission denied/i,
  /invalid_request|validation (?:error|failed)|schema validation|\b400\b|\b422\b/i,
  /context (?:length|window) exceeded|maximum context/i,
];

/** Errors a pause usually cures: network, overloaded or restarting server, stalled stream, rate limit */
const TRANSIENT_PATTERNS: RegExp[] = [
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/i,
  /connection (?:refused|reset|closed|error|lost)|socket hang up|fetch failed|network (?:error|request failed)|other side closed|server disconnected/i,
  /stream stalled|stalled|timed out waiting|timeout waiting|terminated|premature close|unexpected end of|aborted by (?:the )?server/i,
  /\b(?:502|503|504|529)\b|bad gateway|service unavailable|gateway time-?out|overloaded|internal server error|\b500\b/i,
  /\b429\b|rate[- ]?limit|too many requests|try again later/i,
  // Local servers swapping models: omlx answers "409 Model 'x' is busy; cannot start work while unload is pending"
  /\b409\b|\bis busy\b|unload(?:ing)? is pending|model is (?:loading|unloading|being loaded)|loading model/i,
];

export interface OmpErrorEntry {
  text: string;
  /** Reported by a fallback model OMP switched to, not by the model Workbench asked for */
  fallback?: boolean;
}

export type OmpFailureKind = 'transient' | 'permanent';

/** Classify one error text */
export function classifyOmpErrorText(text: string): OmpFailureKind {
  if (!text.trim()) return 'permanent';
  if (PERMANENT_PATTERNS.some((p) => p.test(text))) return 'permanent';
  if (TRANSIENT_PATTERNS.some((p) => p.test(text))) return 'transient';
  return 'permanent';
}

/**
 * Whether a failed phase is worth retrying. The worker model's own error decides: when OMP
 * silently switched to a fallback model that then failed too (a cloud usage limit, say), the
 * fallback's error says nothing about the local server that failed first.
 *
 * `fallbackText` is the phase's final error (result error or stderr tail) for runs that have no
 * per-message errors. A process killed by a signal that the user did not send counts as transient.
 */
export function classifyOmpFailure(input: {
  errors?: readonly OmpErrorEntry[];
  fallbackText?: string;
  signal?: string | null;
  timedOut?: boolean;
}): OmpFailureKind {
  if (input.timedOut) return 'permanent';
  const errors = input.errors ?? [];
  const worker = errors.filter((e) => !e.fallback);
  const decisive = worker.length > 0 ? worker[worker.length - 1] : errors[errors.length - 1];
  if (decisive) return classifyOmpErrorText(decisive.text);
  if (input.fallbackText?.trim()) return classifyOmpErrorText(input.fallbackText);
  return input.signal ? 'transient' : 'permanent';
}
