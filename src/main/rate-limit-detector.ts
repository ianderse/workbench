/**
 * Rate limit detection utility for Claude CLI/SDK calls.
 * Detects rate limit errors in stdout/stderr output and provides context.
 */

import { getClaudeProfileManager } from './claude-profile-manager';
import { getUsageMonitor } from './claude-profile/usage-monitor';
import { debugLog } from '../shared/utils/debug-logger';
import { findStandaloneLimitReset } from './claude-profile/rate-limit-manager';

;

/**
 * Regex pattern to detect Claude Code rate limit messages
 * Matches: "Limit reached · resets Dec 17 at 6am (Europe/Oslo)"
 */
const RATE_LIMIT_PATTERN = /Limit reached\s*[·•]\s*resets\s+(.+?)(?:\s*$|\n)/im;

/**
 * Additional patterns that might indicate rate limiting
 */
const RATE_LIMIT_INDICATORS = [
  /rate\s*limit/i,
  /usage\s*limit/i,
  /limit\s*reached/i,
  /exceeded.*limit/i,
  /too\s*many\s*requests/i,
];

/**
 * Maximum length for error messages sent to renderer.
 * Truncates to prevent exposing excessive internal details.
 */
const MAX_ERROR_LENGTH = 500;

/**
 * Sanitize error output before sending to renderer.
 * Truncates long output to prevent exposing excessive internal details
 * like full paths, API responses, or stack traces.
 */
function sanitizeErrorOutput(output: string): string {
  // Truncate long output to limit exposure of internal details
  if (output.length > MAX_ERROR_LENGTH) {
    return output.substring(0, MAX_ERROR_LENGTH) + '... (truncated)';
  }
  return output;
}

/**
 * Result of rate limit detection
 */
export interface RateLimitDetectionResult {
  /** Whether a rate limit was detected */
  isRateLimited: boolean;
  /** The reset time string if detected (e.g., "Dec 17 at 6am (Europe/Oslo)") */
  resetTime?: string;
  /** Type of limit: 'session' (5-hour) or 'weekly' (7-day) */
  limitType?: 'session' | 'weekly';
  /** The profile ID that hit the limit (if known) */
  profileId?: string;
  /** Best alternative profile to switch to */
  suggestedProfile?: {
    id: string;
    name: string;
  };
  /** Original error message (truncated to 500 chars for security) */
  originalError?: string;
}

/**
 * Classify rate limit type based on reset time string
 */
function classifyLimitType(resetTimeStr: string): 'session' | 'weekly' {
  // Weekly limits mention specific dates like "Dec 17" or "Nov 1"
  // Session limits are typically just times like "11:59pm"
  const hasDate = /[A-Za-z]{3}\s+\d+/i.test(resetTimeStr);
  const hasWeeklyIndicator = resetTimeStr.toLowerCase().includes('week');

  return (hasDate || hasWeeklyIndicator) ? 'weekly' : 'session';
}

/**
 * Detect rate limit from output (stdout + stderr combined)
 */
export function detectRateLimit(
  output: string,
  profileId?: string
): RateLimitDetectionResult {
  // Check for the primary rate limit pattern. It only counts when the message stands on its own
  // line: the same words quoted in model output or code must not mark the account as limited.
  const resetTime = RATE_LIMIT_PATTERN.test(output) ? findStandaloneLimitReset(output) : null;

  if (resetTime) {
    const limitType = classifyLimitType(resetTime);

    // Record the rate limit event in the profile manager
    const profileManager = getClaudeProfileManager();
    const effectiveProfileId = profileId || profileManager.getActiveProfile().id;

    try {
      profileManager.recordRateLimitEvent(effectiveProfileId, resetTime);
    } catch (err) {
      console.error('[RateLimitDetector] Failed to record rate limit event:', err);
    }

    // Find best alternative profile
    const bestProfile = profileManager.getBestAvailableProfile(effectiveProfileId);

    return {
      isRateLimited: true,
      resetTime,
      limitType,
      profileId: effectiveProfileId,
      suggestedProfile: bestProfile ? {
        id: bestProfile.id,
        name: bestProfile.name
      } : undefined,
      originalError: sanitizeErrorOutput(output)
    };
  }

  // Check for secondary rate limit indicators
  for (const pattern of RATE_LIMIT_INDICATORS) {
    if (pattern.test(output)) {
      const profileManager = getClaudeProfileManager();
      const effectiveProfileId = profileId || profileManager.getActiveProfile().id;
      const bestProfile = profileManager.getBestAvailableProfile(effectiveProfileId);

      return {
        isRateLimited: true,
        profileId: effectiveProfileId,
        suggestedProfile: bestProfile ? {
          id: bestProfile.id,
          name: bestProfile.name
        } : undefined,
        originalError: sanitizeErrorOutput(output)
      };
    }
  }

  return { isRateLimited: false };
}

/**
 * Environment for a specific profile, or null when that profile no longer exists or has no
 * credentials (callers then fall back to the best available profile).
 */
/** Whether an account is a Claude Code setup found in its own configuration */
export function isDetectedClaudeCodeProfile(profileId: string): boolean {
  return !!getClaudeProfileManager().getProfile(profileId)?.detected;
}

export function getUsableProfileEnv(profileId: string): Record<string, string> | null {
  const profileManager = getClaudeProfileManager();
  if (!profileManager.getProfile(profileId) || !profileManager.hasValidAuth(profileId)) {
    return null;
  }
  return profileManager.getProfileEnv(profileId);
}

/**
 * Result of getting the best available profile environment
 */
export interface BestProfileEnvResult {
  /** Environment variables for the selected profile */
  env: Record<string, string>;
  /** The profile ID that was selected */
  profileId: string;
  /** The profile name for logging/display */
  profileName: string;
  /** Whether a swap was performed (true if different from active profile) */
  wasSwapped: boolean;
  /** Reason for the swap if one occurred */
  swapReason?: 'rate_limited' | 'at_capacity' | 'proactive' | 'not_authenticated';
  /** The original active profile if a swap occurred */
  originalProfile?: {
    id: string;
    name: string;
  };
}

/**
 * Get environment variables for the BEST available Claude profile and persist the profile swap.
 *
 * IMPORTANT: This function has the side effect of calling profileManager.setActiveProfile()
 * when a better profile is found. This modifies global state and persists the profile swap.
 *
 * This is the preferred function for SDK operations that need profile environment.
 * It automatically handles:
 * 1. Checking if the active profile is explicitly rate-limited (received 429/rate limit error)
 * 2. Checking if the active profile is at capacity (100% weekly usage)
 * 3. Finding a better alternative profile if available
 * 4. PERSISTING the swap by updating the active profile
 *
 * Use this instead of getProfileEnv() for any operation that will make Claude API calls.
 *
 * @returns Object containing env vars and metadata about which profile was selected
 */
export function getBestAvailableProfileEnv(): BestProfileEnvResult {
  const profileManager = getClaudeProfileManager();
  const activeProfile = profileManager.getActiveProfile();

  debugLog('[RateLimitDetector] getBestAvailableProfileEnv() called:', {
    activeProfileId: activeProfile.id,
    activeProfileName: activeProfile.name,
    hasConfigDir: !!activeProfile.configDir,
    configDir: activeProfile.configDir,
    weeklyUsagePercent: activeProfile.usage?.weeklyUsagePercent,
  });

  // Check for explicit rate limit (from previous API errors)
  const rateLimitStatus = profileManager.isProfileRateLimited(activeProfile.id);

  // Check for capacity limit (100% weekly usage - will be rate limited on next request)
  const isAtCapacity = activeProfile.usage?.weeklyUsagePercent !== undefined &&
                       activeProfile.usage.weeklyUsagePercent >= 100;

  // An account without credentials can't run anything (e.g. an "Add account" sign-in that
  // never finished): move to one that is signed in
  // (A profile without a config dir uses the default credentials and is left alone.)
  const isSignedOut = !!activeProfile.configDir && !profileManager.hasValidAuth(activeProfile.id);

  // Determine if we need to find an alternative
  const needsSwap = rateLimitStatus.limited || isAtCapacity || isSignedOut;
  const swapReason: BestProfileEnvResult['swapReason'] = isSignedOut
    ? 'not_authenticated'
    : rateLimitStatus.limited
      ? 'rate_limited'
      : isAtCapacity
        ? 'at_capacity'
        : undefined;

  if (needsSwap) {
    debugLog('[RateLimitDetector] Active profile needs swap:', {
      activeProfile: activeProfile.name,
      isRateLimited: rateLimitStatus.limited,
      isAtCapacity,
      weeklyUsage: activeProfile.usage?.weeklyUsagePercent,
      limitType: rateLimitStatus.type,
      resetAt: rateLimitStatus.resetAt
    });

    // Try to find a better profile. Never switch to one without credentials: it would fail
    // every run and become the active account.
    const candidate = profileManager.getBestAvailableProfile(activeProfile.id);
    const bestProfile = candidate && profileManager.hasValidAuth(candidate.id) ? candidate : null;

    if (bestProfile) {
      debugLog('[RateLimitDetector] Using alternative profile:', {
        originalProfile: activeProfile.name,
        alternativeProfile: bestProfile.name,
        reason: swapReason
      });

      // Persist the swap by updating the active profile
      // This ensures the UI reflects which account is actually being used
      profileManager.setActiveProfile(bestProfile.id);
      console.warn('[RateLimitDetector] Switched active profile:', {
        from: activeProfile.name,
        to: bestProfile.name,
        reason: swapReason
      });

      // Trigger a usage refresh so the UI shows the new active profile
      // This updates the UsageIndicator in the header
      // We use fire-and-forget pattern to avoid making this function async
      try {
        const usageMonitor = getUsageMonitor();
        // Force refresh all profiles usage data, which will emit 'all-profiles-usage-updated' event
        // The UI components listen for this and will update automatically
        usageMonitor.getAllProfilesUsage(true).then((allProfilesUsage) => {
          if (allProfilesUsage) {
            // Find the new active profile in allProfiles and emit its usage
            // This ensures UsageIndicator.usage state also updates to show the new active account
            const newActiveProfile = allProfilesUsage.allProfiles.find(p => p.isActive);
            if (newActiveProfile) {
              // Construct a ClaudeUsageSnapshot for the new active profile
              const newActiveUsage = {
                profileId: newActiveProfile.profileId,
                profileName: newActiveProfile.profileName,
                profileEmail: newActiveProfile.profileEmail,
                sessionPercent: newActiveProfile.sessionPercent,
                weeklyPercent: newActiveProfile.weeklyPercent,
                sessionResetTimestamp: newActiveProfile.sessionResetTimestamp,
                weeklyResetTimestamp: newActiveProfile.weeklyResetTimestamp,
                fetchedAt: allProfilesUsage.fetchedAt,
                needsReauthentication: newActiveProfile.needsReauthentication,
              };
              usageMonitor.emit('usage-updated', newActiveUsage);
            }
            // Also emit all-profiles-usage-updated for the other profiles list
            usageMonitor.emit('all-profiles-usage-updated', allProfilesUsage);
          }
        }).catch((err) => {
          console.warn('[RateLimitDetector] Failed to refresh usage after swap:', err);
        });
      } catch (err) {
        // Usage monitor may not be initialized yet, that's OK
        console.warn('[RateLimitDetector] Could not trigger usage refresh:', err);
      }

      const profileEnv = profileManager.getProfileEnv(bestProfile.id);

      debugLog('[RateLimitDetector] Profile env for swapped profile:', {
        profileId: bestProfile.id,
        hasClaudeConfigDir: !!profileEnv.CLAUDE_CONFIG_DIR,
        claudeConfigDir: profileEnv.CLAUDE_CONFIG_DIR,
        hasOAuthToken: !!profileEnv.CLAUDE_CODE_OAUTH_TOKEN,
        envKeys: Object.keys(profileEnv),
      });

      return {
        env: ensureCleanProfileEnv(profileEnv),
        profileId: bestProfile.id,
        profileName: bestProfile.name,
        wasSwapped: true,
        swapReason,
        originalProfile: {
          id: activeProfile.id,
          name: activeProfile.name
        }
      };
    } else {
      debugLog('[RateLimitDetector] No alternative profile available, using rate-limited/at-capacity profile');
    }
  }

  // Use active profile (either it's fine, or no better alternative exists)
  const activeEnv = profileManager.getActiveProfileEnv();

  debugLog('[RateLimitDetector] Using active profile env (no swap):', {
    profileId: activeProfile.id,
    hasClaudeConfigDir: !!activeEnv.CLAUDE_CONFIG_DIR,
    claudeConfigDir: activeEnv.CLAUDE_CONFIG_DIR,
    hasOAuthToken: !!activeEnv.CLAUDE_CODE_OAUTH_TOKEN,
    envKeys: Object.keys(activeEnv),
  });

  return {
    env: ensureCleanProfileEnv(activeEnv),
    profileId: activeProfile.id,
    profileName: activeProfile.name,
    wasSwapped: false
  };
}

/**
 * Ensure the profile environment is clean for subprocess invocation.
 *
 * When CLAUDE_CONFIG_DIR is set, we MUST clear both CLAUDE_CODE_OAUTH_TOKEN and
 * ANTHROPIC_API_KEY to prevent the Claude Agent SDK from using hardcoded/cached
 * tokens or API keys (e.g., from .env file or shell environment) instead of reading
 * fresh credentials from the specified config directory.
 *
 * ANTHROPIC_API_KEY is cleared to prevent Claude Code from using API keys present
 * in the shell environment, which would cause it to show "Claude API" instead of
 * "Claude Max" and bypass the intended config dir credentials.
 *
 * This is critical for multi-account switching: when switching from a rate-limited
 * account to an available one, the subprocess must use the new account's credentials.
 *
 * Also warns if the profile env is empty, which indicates a misconfigured profile.
 *
 * @param env - Profile environment from getProfileEnv() or getActiveProfileEnv()
 * @returns Environment with CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY cleared if CLAUDE_CONFIG_DIR is set
 */
export function ensureCleanProfileEnv(env: Record<string, string>): Record<string, string> {
  debugLog('[RateLimitDetector] ensureCleanProfileEnv() input:', {
    hasClaudeConfigDir: !!env.CLAUDE_CONFIG_DIR,
    claudeConfigDir: env.CLAUDE_CONFIG_DIR,
    hasOAuthToken: !!env.CLAUDE_CODE_OAUTH_TOKEN,
    willClearOAuthToken: !!env.CLAUDE_CONFIG_DIR,
    willClearApiKey: !!env.CLAUDE_CONFIG_DIR,
  });

  // Warn if the profile environment is empty — this likely indicates a misconfigured profile
  if (Object.keys(env).length === 0) {
    console.warn('[RateLimitDetector] ensureCleanProfileEnv() received empty profile env — profile may be misconfigured');
  }

  if (env.CLAUDE_CONFIG_DIR) {
    // Clear CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY to ensure SDK uses credentials from CLAUDE_CONFIG_DIR
    // ANTHROPIC_API_KEY must also be cleared to prevent Claude Code from using
    // API keys that may be present in the shell environment instead of the config dir credentials.
    const cleanedEnv = {
      ...env,
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_API_KEY: ''
    };

    debugLog('[RateLimitDetector] ensureCleanProfileEnv() output:', {
      claudeConfigDirPreserved: 'CLAUDE_CONFIG_DIR' in cleanedEnv,
      claudeConfigDir: (cleanedEnv as Record<string, string>).CLAUDE_CONFIG_DIR,
      oauthTokenCleared: cleanedEnv.CLAUDE_CODE_OAUTH_TOKEN === '',
      envKeys: Object.keys(cleanedEnv),
    });

    return cleanedEnv;
  }
  return env;
}

/**
 * Information about a rate limit event for the UI
 */
export interface SDKRateLimitInfo {
  /** Source of the rate limit (which feature hit it) */
  source: 'task' | 'title-generator' | 'other';
  /** Project ID if applicable */
  projectId?: string;
  /** Task ID if applicable */
  taskId?: string;
  /** The reset time string */
  resetTime?: string;
  /** Type of limit */
  limitType?: 'session' | 'weekly';
  /** Profile that hit the limit */
  profileId: string;
  /** Profile name for display */
  profileName?: string;
  /** Suggested alternative profile */
  suggestedProfile?: {
    id: string;
    name: string;
  };
  /** When detected */
  detectedAt: Date;
  /** Original error message (truncated to 500 chars for security) */
  originalError?: string;

  // Auto-swap information
  /** Whether this rate limit was automatically handled via account swap */
  wasAutoSwapped?: boolean;
  /** Profile that was swapped to (if auto-swapped) */
  swappedToProfile?: {
    id: string;
    name: string;
  };
  /** Why the swap occurred: 'proactive' (before limit) or 'reactive' (after limit hit) */
  swapReason?: 'proactive' | 'reactive';
}

/**
 * Create SDK rate limit info object for emitting to UI
 */
export function createSDKRateLimitInfo(
  source: SDKRateLimitInfo['source'],
  detection: RateLimitDetectionResult,
  options?: {
    projectId?: string;
    taskId?: string;
  }
): SDKRateLimitInfo {
  const profileManager = getClaudeProfileManager();
  const profile = detection.profileId
    ? profileManager.getProfile(detection.profileId)
    : profileManager.getActiveProfile();

  return {
    source,
    projectId: options?.projectId,
    taskId: options?.taskId,
    resetTime: detection.resetTime,
    limitType: detection.limitType,
    profileId: detection.profileId || profileManager.getActiveProfile().id,
    profileName: profile?.name,
    suggestedProfile: detection.suggestedProfile,
    detectedAt: new Date(),
    originalError: detection.originalError
  };
}
