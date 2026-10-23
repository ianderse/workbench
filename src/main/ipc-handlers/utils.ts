/**
 * Shared utilities for IPC handlers
 */

import type { BrowserWindow } from "electron";

/**
 * Track last-warn timestamps per channel to prevent log spam.
 * When a renderer frame is disposed, we log once per channel within cooldown period.
 * Uses timestamp-based approach instead of setInterval to avoid timer leaks.
 */
const warnTimestamps = new Map<string, number>();
const WARN_COOLDOWN_MS = 5000; // 5 seconds between warnings per channel

/** Circuit breaker: kill agents after consecutive renderer disposal errors */
const MAX_CONSECUTIVE_DISPOSAL_ERRORS = 10;
const RENDERER_RETRY_BACKOFF_MS = 500;
let agentManagerRef: { killAll: () => void | Promise<void> } | null = null;
let circuitBreakerTriggered = false;
/**
 * Sends that reached no window at all. One window's dead renderer must not kill the agents
 * the others are watching, so only a send that nothing took counts toward the breaker.
 */
let consecutiveDisposalErrors = 0;
/** Back-off per window: a sick window is skipped for a moment, the healthy ones keep their events */
const unavailableUntil = new Map<number, number>();

/** Every project window that should receive main-process events (set once at startup) */
let windowsProvider: (() => BrowserWindow[]) | null = null;

/**
 * Register where renderer events go. With several project windows open, every window gets
 * each event and keeps the ones that belong to the project it shows.
 */
export function setRendererWindowsProvider(provider: (() => BrowserWindow[]) | null): void {
  windowsProvider = provider;
}

/** Set agent manager reference for circuit breaker cleanup */
export function setAgentManagerRef(manager: { killAll: () => void | Promise<void> }): void {
  agentManagerRef = manager;
}

/**
 * Check if a channel is within the warning cooldown period.
 * @returns true if within cooldown (should skip warning), false if cooldown expired
 */
function isWithinCooldown(channel: string): boolean {
  const lastWarn = warnTimestamps.get(channel) ?? 0;
  return Date.now() - lastWarn < WARN_COOLDOWN_MS;
}

/**
 * Record a warning timestamp for a channel.
 * Enforces a hard cap of 100 entries to prevent unbounded memory growth.
 */
function recordWarning(channel: string): void {
  warnTimestamps.set(channel, Date.now());

  // Prune if more than 100 entries to free memory
  if (warnTimestamps.size > 100) {
    const now = Date.now();

    // First, remove expired entries
    for (const [ch, ts] of warnTimestamps.entries()) {
      if (now - ts >= WARN_COOLDOWN_MS) {
        warnTimestamps.delete(ch);
      }
    }

    // If still over 100 entries, remove oldest (Map preserves insertion order)
    if (warnTimestamps.size > 100) {
      const entriesToRemove = warnTimestamps.size - 100;
      let removed = 0;
      for (const ch of warnTimestamps.keys()) {
        warnTimestamps.delete(ch);
        if (++removed >= entriesToRemove) {
          break;
        }
      }
    }
  }
}

function isDisposalErrorMessage(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return normalized.includes("disposed") || normalized.includes("destroyed") || normalized.includes("detached");
}

/**
 * Back off sending to one window whose renderer is unavailable. Only thrown disposal errors
 * count toward the agent circuit breaker; proactive skips (crashed renderer,
 * destroyed/detached frame) don't, so a renderer that is being recovered doesn't kill
 * running agents.
 */
function recordDisposalFailure(windowId: number, channel: string, warningPrefix: string, countTowardBreaker = true): void {
  unavailableUntil.set(windowId, Date.now() + RENDERER_RETRY_BACKOFF_MS);
  if (countTowardBreaker) {
    thrownDisposalThisSend = true;
  }

  if (!isWithinCooldown(channel)) {
    console.warn(`${warningPrefix}: ${channel}`);
    recordWarning(channel);
  }
}

/** Set while sending: a window threw a disposal error for this event */
let thrownDisposalThisSend = false;

/** After a send that reached nothing, the renderers may all be gone */
function recordSendReachedNoWindow(): void {
  if (!thrownDisposalThisSend) return;
  consecutiveDisposalErrors++;

  if (consecutiveDisposalErrors >= MAX_CONSECUTIVE_DISPOSAL_ERRORS && !circuitBreakerTriggered && agentManagerRef) {
    circuitBreakerTriggered = true;
    console.error("[safeSendToRenderer] Circuit breaker triggered: killing all agents after renderer death");
    Promise.resolve(agentManagerRef.killAll()).catch((err) => {
      console.error("[safeSendToRenderer] Error killing agents:", err);
    });
  }
}

/**
 * Safely send IPC message to renderer with frame disposal checks
 *
 * This prevents "Render frame was disposed" errors that occur when:
 * 1. Multiple agents are running and producing output
 * 2. The main process tries to send data to renderer windows via webContents.send()
 * 3. The renderer frame has been disposed/gone, but the main process hasn't detected this
 *
 * @param getMainWindow - Fallback window when no window provider is registered
 * @param channel - IPC channel to send on
 * @param args - Arguments to send to the renderer
 * @returns true if message was sent, false if window was destroyed or not available
 *
 * @example
 * ```ts
 * // Instead of:
 * mainWindow.webContents.send(IPC_CHANNELS.TASK_LOG, taskId, log);
 *
 * // Use:
 * safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_LOG, taskId, log);
 * ```
 */
export function safeSendToRenderer(
  getMainWindow: () => BrowserWindow | null,
  channel: string,
  ...args: unknown[]
): boolean {
  // Events reach every project window; each renderer keeps the ones for the project it shows.
  // The provider hands back its own live-window array, so it is never written to here.
  const provided = windowsProvider?.();
  const targets = provided && provided.length > 0 ? provided : [getMainWindow()];

  thrownDisposalThisSend = false;
  let sent = false;
  for (const window of targets) {
    if (window) sent = sendToWindow(window, channel, args) || sent;
  }

  if (sent) {
    // A window took it, so the renderers are not all gone (allow re-trigger after recovery)
    consecutiveDisposalErrors = 0;
    circuitBreakerTriggered = false;
  } else {
    recordSendReachedNoWindow();
  }
  return sent;
}

/** Send to one window with the frame disposal checks described above */
function sendToWindow(window: BrowserWindow, channel: string, args: unknown[]): boolean {
  try {
    // Check if window or webContents is destroyed
    // isDestroyed() returns true if the window has been closed and destroyed
    if (window.isDestroyed()) {
      if (!isWithinCooldown(channel)) {
        console.warn(`[safeSendToRenderer] Skipping send to destroyed window: ${channel}`);
        recordWarning(channel);
      }
      unavailableUntil.delete(window.id);
      return false;
    }

    // This window is in its back-off window; the others still get the event
    const backOff = unavailableUntil.get(window.id) ?? 0;
    if (backOff > Date.now()) {
      if (!isWithinCooldown(channel)) {
        console.warn(`[safeSendToRenderer] Renderer unavailable, backing off send: ${channel}`);
        recordWarning(channel);
      }
      return false;
    }

    const webContents = window.webContents;

    // Check if webContents is destroyed (can happen independently of window)
    if (!webContents || webContents.isDestroyed()) {
      if (!isWithinCooldown(channel)) {
        console.warn(`[safeSendToRenderer] Skipping send to destroyed webContents: ${channel}`);
        recordWarning(channel);
      }
      return false;
    }

    // On Electron 40, webContents.send may report "Error sending from webFrameMain"
    // without always throwing synchronously. Proactive checks prevent hot loops.
    if (typeof webContents.isCrashed === "function" && webContents.isCrashed()) {
      recordDisposalFailure(window.id, channel, "[safeSendToRenderer] Renderer crashed, skipping send", false);
      return false;
    }

    const mainFrame = webContents.mainFrame;
    if (mainFrame && (mainFrame.isDestroyed() || mainFrame.detached)) {
      const reason = mainFrame.isDestroyed() ? "destroyed" : "detached";
      recordDisposalFailure(window.id, channel, `[safeSendToRenderer] Main frame ${reason}, skipping send`, false);
      return false;
    }

    // All checks passed - safe to send
    webContents.send(channel, ...args);
    unavailableUntil.delete(window.id);
    return true;
  } catch (error) {
    // Catch any disposal errors that might occur between our checks and the actual send
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Only log disposal errors once per channel to avoid log spam
    if (isDisposalErrorMessage(errorMessage)) {
      recordDisposalFailure(window.id, channel, "[safeSendToRenderer] Frame disposed, skipping send");
    } else {
      console.error(`[safeSendToRenderer] Error sending to renderer:`, error);
    }
    return false;
  }
}

/**
 * Reset all safe-send module state (for testing only)
 * @internal Test hook
 */
export function _resetSafeSendStateForTest(): void {
  warnTimestamps.clear();
  windowsProvider = null;
  consecutiveDisposalErrors = 0;
  circuitBreakerTriggered = false;
  thrownDisposalThisSend = false;
  unavailableUntil.clear();
  agentManagerRef = null;
}
