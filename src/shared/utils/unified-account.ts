/**
 * Unified Account Utilities
 *
 * Conversion utilities and helpers for unified account management.
 * These functions convert between OAuth/API profiles and the unified account format.
 */

import type { ClaudeProfile } from '../types/agent';
import type { APIProfile } from '../types/profile';
import type { UnifiedAccount, RateLimitType } from '../types/unified-account';

// ============================================
// Constants
// ============================================

/**
 * ID prefix for OAuth accounts in unified format
 */
export const OAUTH_ID_PREFIX = 'oauth-';

/**
 * ID prefix for API accounts in unified format
 */
const API_ID_PREFIX = 'api-';

// ============================================
// Conversion Functions
// ============================================

/**
 * Convert a ClaudeProfile (OAuth) to UnifiedAccount format
 *
 * @param profile - The OAuth profile to convert
 * @param isActive - Whether this is the currently active account
 * @param options - Additional options for conversion
 * @param options.isRateLimited - Whether the profile is currently rate limited
 * @param options.rateLimitType - The type of rate limit (session or weekly)
 * @param options.isAuthenticated - Whether the profile is authenticated (REQUIRED - must be computed by caller)
 */
export function claudeProfileToUnified(
  profile: ClaudeProfile,
  isActive: boolean,
  options?: {
    isRateLimited?: boolean;
    rateLimitType?: RateLimitType;
    isAuthenticated?: boolean;
  }
): UnifiedAccount {
  // Check for rate limit from profile's rate limit events
  const now = new Date();
  const activeRateLimit = profile.rateLimitEvents?.find(e => e.resetAt > now);
  const isRateLimited = options?.isRateLimited ?? !!activeRateLimit;
  // Use explicit isAuthenticated from options, falling back to profile property (which may be undefined for raw profiles)
  const isAuthenticated = options?.isAuthenticated ?? profile.isAuthenticated ?? false;

  // Derive isAvailable from the computed values
  const isAvailable = !!(isAuthenticated && !isRateLimited);

  return {
    id: `${OAUTH_ID_PREFIX}${profile.id}`,
    name: profile.name,
    type: 'oauth',
    displayName: profile.name,
    identifier: profile.email || profile.id,
    isActive,
    isNext: false, // Computed later based on priority order
    isAvailable,
    hasUnlimitedUsage: false, // OAuth accounts have usage limits
    sessionPercent: profile.usage?.sessionUsagePercent,
    weeklyPercent: profile.usage?.weeklyUsagePercent,
    isRateLimited,
    rateLimitType: options?.rateLimitType ?? activeRateLimit?.type,
    isAuthenticated,
    needsReauthentication: false // Set separately if needed
  };
}

/**
 * Convert an APIProfile to UnifiedAccount format
 *
 * @param profile - The API profile to convert
 * @param isActive - Whether this is the currently active account
 * @param isAuthenticated - Whether the API key is valid (has been tested). Defaults to false for safety.
 */
export function apiProfileToUnified(
  profile: APIProfile,
  isActive: boolean,
  isAuthenticated: boolean = false
): UnifiedAccount {
  // API profiles are available if they have a valid API key
  // They have unlimited usage (pay-per-use)
  const isAvailable = isAuthenticated && !!profile.apiKey;

  return {
    id: `${API_ID_PREFIX}${profile.id}`,
    name: profile.name,
    type: 'api',
    displayName: profile.name,
    identifier: profile.baseUrl,
    isActive,
    isNext: false, // Computed later based on priority order
    isAvailable,
    hasUnlimitedUsage: true, // API profiles are pay-per-use with no rate limits
    sessionPercent: undefined, // Not applicable to API profiles
    weeklyPercent: undefined, // Not applicable to API profiles
    isRateLimited: false, // API profiles don't have rate limits
    rateLimitType: undefined,
    isAuthenticated,
    needsReauthentication: false
  };
}