/**
 * Rate Limit Manager Module
 * Handles rate limit event recording and status checking
 */

import type { ClaudeProfile, ClaudeRateLimitEvent } from '../../shared/types';
import { parseResetTime, classifyRateLimitType } from './usage-parser';
import { detectClaudeLimitMessage } from '../claude-code/limit';

/**
 * Claude subscription limits reset within a week (weekly limit) or within hours (session
 * limit). A reset further away than this is not a real limit: it comes from text that only
 * looks like a limit message (source code, a diff or a chat shown in a terminal), e.g.
 * "Dec 17 at 6am (Europe/Oslo)" two months ahead.
 */
const MAX_RATE_LIMIT_RESET_MS = 8 * 24 * 60 * 60 * 1000;

/** ANSI escape sequences (CSI / OSC) and other control characters */
const ANSI_PATTERN = /\x1b\[[0-9;?!>]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Shape of a real reset string from Claude Code, e.g. "8:30pm (Asia/Yerevan)", "6am",
 * "Dec 17 at 6am (Europe/Oslo)", "Nov 1, 10:59am", "Oct 10, 23:15". Anything else (quotes,
 * escape codes, code around the message) means the text was not a limit message.
 */
const RESET_TEXT_PATTERN =
  /^(?:[A-Za-z]{3,9}\.?\s+\d{1,2}(?:,|\s+at)?\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*\([A-Za-z0-9_+\-/]+\))?$/i;

/** Remove terminal escape codes from a reset string and trim it */
function cleanResetText(resetTimeStr: string): string {
  return resetTimeStr.replace(ANSI_PATTERN, '').trim();
}

/** Whether a reset string looks like one Claude Code prints */
function isPlausibleResetText(resetTimeStr: string): boolean {
  if (!resetTimeStr || CONTROL_CHARS.test(resetTimeStr)) return false;
  return RESET_TEXT_PATTERN.test(resetTimeStr.trim());
}

/** Leading terminal UI decoration before a message (box lines, bullets, result markers) */
const TUI_PREFIX = /^[\s\u2500-\u257F\u23BF\u25CF\u23FA\u273B\u2022>]+/;
/** Trailing box lines of a framed message */
const TUI_SUFFIX = /[\s\u2500-\u257F]+$/;

/**
 * The reset string of a Claude limit message that stands on its own line (after removing
 * escape codes and terminal UI decoration). A limit message inside other text, such as source
 * code, a diff or a chat answer quoting one, returns null.
 */
export function findStandaloneLimitReset(output: string): string | null {
  for (const rawLine of output.split(/\r?\n|\r/)) {
    const line = cleanResetText(rawLine).replace(TUI_PREFIX, '').replace(TUI_SUFFIX, '');
    if (!line || !/limit/i.test(line)) continue;
    const limit = detectClaudeLimitMessage(line);
    if (limit?.resetText) return limit.resetText;
  }
  return null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * Whether a stored rate limit event can be a real Claude limit: valid dates, a reset no more
 * than {@link MAX_RATE_LIMIT_RESET_MS} after the hit, and a clean reset string.
 */
function isPlausibleRateLimitEvent(event: ClaudeRateLimitEvent): boolean {
  const hitAt = toDate(event?.hitAt);
  const resetAt = toDate(event?.resetAt);
  if (!hitAt || !resetAt) return false;
  if (resetAt.getTime() - hitAt.getTime() > MAX_RATE_LIMIT_RESET_MS) return false;
  if (event.resetTimeString && CONTROL_CHARS.test(event.resetTimeString)) return false;
  return true;
}

export interface RecordRateLimitOptions {
  /** Exact reset time when known (e.g. from Claude Code's rate_limit_event) */
  resetAt?: Date;
  /** Time of the hit (defaults to now) */
  now?: Date;
}

/**
 * Record a rate limit event for a profile.
 *
 * Returns null (and records nothing) when the reset string isn't one Claude Code prints or the
 * reset is implausibly far away: such "limits" come from terminal output or model text that
 * merely quotes a limit message, and would otherwise flag a working account as rate limited.
 */
export function recordRateLimitEvent(
  profile: ClaudeProfile,
  resetTimeStr: string,
  options: RecordRateLimitOptions = {}
): ClaudeRateLimitEvent | null {
  const now = options.now ?? new Date();
  const resetText = cleanResetText(resetTimeStr ?? '');
  const exactResetAt = options.resetAt && !Number.isNaN(options.resetAt.getTime()) ? options.resetAt : undefined;

  if (!exactResetAt && !isPlausibleResetText(resetText)) {
    return null;
  }

  const resetAt = exactResetAt ?? parseResetTime(resetText);
  const untilReset = resetAt.getTime() - now.getTime();
  if (untilReset > MAX_RATE_LIMIT_RESET_MS) {
    return null;
  }

  const type: ClaudeRateLimitEvent['type'] = exactResetAt
    // Session limits reset within 5 hours; anything later is the weekly limit
    ? (untilReset > 5 * 60 * 60 * 1000 ? 'weekly' : 'session')
    : classifyRateLimitType(resetText);

  const event: ClaudeRateLimitEvent = {
    type,
    hitAt: now,
    resetAt,
    resetTimeString: resetText || resetAt.toISOString()
  };

  // Keep last 10 events
  profile.rateLimitEvents = [
    event,
    ...(profile.rateLimitEvents || []).slice(0, 9)
  ];

  return event;
}

/**
 * Check if a profile is currently rate-limited
 */
export function isProfileRateLimited(
  profile: ClaudeProfile
): { limited: boolean; type?: 'session' | 'weekly'; resetAt?: Date } {
  if (!profile || !profile.rateLimitEvents?.length) {
    return { limited: false };
  }

  const now = new Date();
  // Check the most recent real event (implausible ones are ignored, see recordRateLimitEvent)
  const latestEvent = profile.rateLimitEvents.find(isPlausibleRateLimitEvent);
  const resetAt = latestEvent ? toDate(latestEvent.resetAt) : null;

  if (latestEvent && resetAt && resetAt > now) {
    return {
      limited: true,
      type: latestEvent.type,
      resetAt
    };
  }

  return { limited: false };
}

/**
 * Drop rate limit events that are implausible (see {@link isPlausibleRateLimitEvent}) or whose
 * reset time has passed. Returns true when anything was removed.
 */
export function pruneRateLimitEvents(profile: ClaudeProfile, now: Date = new Date()): boolean {
  const events = profile.rateLimitEvents;
  if (!events?.length) return false;
  const kept = events.filter((event) => {
    if (!isPlausibleRateLimitEvent(event)) return false;
    const resetAt = toDate(event.resetAt);
    return !!resetAt && resetAt > now;
  });
  if (kept.length === events.length) return false;
  profile.rateLimitEvents = kept;
  return true;
}

/**
 * Clear rate limit events for a profile (e.g., when they've reset)
 */
export function clearRateLimitEvents(profile: ClaudeProfile): void {
  profile.rateLimitEvents = [];
}
