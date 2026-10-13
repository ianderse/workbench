/**
 * Provider Detection Utilities
 *
 * Detects API provider type from baseUrl patterns.
 * Mirrors the logic from usage-monitor.ts for use in renderer process.
 *
 * NOTE: Keep this in sync with usage-monitor.ts provider detection logic
 */

/**
 * API Provider type for usage monitoring
 * Determines which usage endpoint to query and how to normalize responses
 */
export type ApiProvider = 'anthropic' | 'openai' | 'zai' | 'zhipu' | 'unknown';

/**
 * Provider detection patterns
 * Maps baseUrl patterns to provider types
 */
interface ProviderPattern {
  provider: ApiProvider;
  domainPatterns: string[];
}

const PROVIDER_PATTERNS: readonly ProviderPattern[] = [
  {
    provider: 'anthropic',
    domainPatterns: ['api.anthropic.com']
  },
  {
    provider: 'zai',
    domainPatterns: ['api.z.ai', 'z.ai']
  },
  {
    provider: 'openai',
    domainPatterns: ['chatgpt.com', 'api.openai.com']
  },
  {
    provider: 'zhipu',
    domainPatterns: ['open.bigmodel.cn', 'dev.bigmodel.cn', 'bigmodel.cn']
  }
] as const;

/**
 * Detect API provider from baseUrl
 * Extracts domain and matches against known provider patterns
 *
 * @param baseUrl - The API base URL (e.g., 'https://api.z.ai/api/anthropic')
 * @returns The detected provider type ('anthropic' | 'zai' | 'zhipu' | 'unknown')
 *
 * @example
 * detectProvider('https://api.anthropic.com') // returns 'anthropic'
 * detectProvider('https://api.z.ai/api/anthropic') // returns 'zai'
 * detectProvider('https://open.bigmodel.cn/api/anthropic') // returns 'zhipu'
 * detectProvider('https://unknown.com/api') // returns 'unknown'
 */
export function detectProvider(baseUrl: string): ApiProvider {
  try {
    // Extract domain from URL
    const url = new URL(baseUrl);
    const domain = url.hostname;

    // Match against provider patterns
    for (const pattern of PROVIDER_PATTERNS) {
      for (const patternDomain of pattern.domainPatterns) {
        if (domain === patternDomain || domain.endsWith(`.${patternDomain}`)) {
          return pattern.provider;
        }
      }
    }

    // No match found
    return 'unknown';
  } catch (_error) {
    // Invalid URL format
    return 'unknown';
  }
}

