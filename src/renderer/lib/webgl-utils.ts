/**
 * WebGL Utilities
 *
 * Feature detection and compatibility checks for WebGL rendering.
 * Inspired by Hyper's WebGL2 detection patterns.
 */

/**
 * Check if WebGL2 is supported in the current browser
 */
export function supportsWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    return gl !== null;
  } catch {
    return false;
  }
}

/**
 * Check if the current browser is Safari
 * Note: Chrome's user agent also contains "Safari", so we need to exclude it
 */
export function isSafari(): boolean {
  try {
    const userAgent = navigator.userAgent.toLowerCase();
    // Safari includes "safari" but not "chrome" or "chromium"
    // Chrome/Chromium include both "safari" and "chrome"/"chromium"
    return (
      userAgent.includes('safari') &&
      !userAgent.includes('chrome') &&
      !userAgent.includes('chromium')
    );
  } catch {
    return false;
  }
}

/**
 * Get the maximum number of WebGL contexts supported by the browser
 * This is a conservative estimate - browsers typically support 8-16
 */
export function getMaxWebGLContexts(): number {
  // Conservative default
  let maxContexts = 8;

  try {
    // Try to detect browser
    const userAgent = navigator.userAgent.toLowerCase();

    if (userAgent.includes('chrome') || userAgent.includes('chromium')) {
      // Chrome/Chromium typically supports 16
      maxContexts = 16;
    } else if (userAgent.includes('firefox')) {
      // Firefox typically supports 32
      maxContexts = 32;
    } else if (isSafari()) {
      // Safari is more conservative
      maxContexts = 8;
    }

    // For Electron, we can be a bit more generous
    if (userAgent.includes('electron')) {
      maxContexts = Math.min(maxContexts, 12); // Use 12 for safety
    }
  } catch {
    // Fallback to conservative default
  }

  return maxContexts;
}