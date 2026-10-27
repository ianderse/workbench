/**
 * Usage Indicator - Real-time Claude usage display in header
 *
 * Displays current session/weekly usage as a badge with color-coded status.
 * - Hover to show breakdown popup (auto-closes on mouse leave)
 * - Click to pin popup open (stays until clicking outside)
 *
 * - Claude accounts (subscription): shows session/weekly usage bars
 * - An active API profile (Anthropic-compatible endpoint): shows "API key" (pay as you go)
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { Activity, TrendingUp, AlertCircle } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from './ui/popover';
import { useTranslation } from 'react-i18next';
import type { ClaudeUsageSnapshot } from '../../shared/types/agent';
import type { AppSection } from './settings/AppSettings';
import { useSettingsStore } from '../stores/settings-store';
import { UsageBreakdown } from './usage/UsageBreakdown';
import { useUsageStore } from '../stores/usage-store';
import {
  THRESHOLD_ELEVATED, THRESHOLD_WARNING, getBadgeColorClasses, getColorClass,
} from './usage/usage-colors';

/** How long the badge waits for a newly selected account's usage before showing it as unavailable */
export const USAGE_LOADING_TIMEOUT_MS = 20_000;

export function UsageIndicator() {
  const { t } = useTranslation(['common']);
  // Starts from the last snapshot, so mounting again (the sidebar opening) never blanks the store
  const [usage, setUsage] = useState<ClaudeUsageSnapshot | null>(() => useUsageStore.getState().usage);
  // Shared, so the usage simulator's preview in Settings shows the same numbers without asking again
  useEffect(() => { useUsageStore.getState().setUsage(usage); }, [usage]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAvailable, setIsAvailable] = useState(false);
  const [activeProfileNeedsReauth, setActiveProfileNeedsReauth] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // The badge sits inside the sidebar footer; open the breakdown above the whole footer with the
  // same 0.5rem gap it keeps from the sidebar's sides (rem-based so it follows the UI scale)
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [popoverOffset, setPopoverOffset] = useState(8);
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!isOpen || !trigger?.parentElement) return;
    const gap = 0.5 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    const footerTop = trigger.parentElement.getBoundingClientRect().top;
    setPopoverOffset(Math.round(trigger.getBoundingClientRect().top - footerTop + gap));
  }, [isOpen]);

  // An active API profile (Anthropic-compatible endpoint) bills per token: no usage limits to show
  const activeApiProfile = useSettingsStore((state) => state.profiles.find((p) => p.id === state.activeProfileId) ?? null);
  // Claude subscription accounts report session and weekly usage
  const hasUsageMonitoring = !activeApiProfile;

  /**
   * Navigate to settings accounts tab
   */
  const handleOpenAccounts = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Close the popover first
    setIsOpen(false);
    setIsPinned(false);
    // Dispatch custom event to open settings with accounts section
    // Small delay to allow popover to close first
    setTimeout(() => {
      const event = new CustomEvent<AppSection>('open-app-settings', {
        detail: 'accounts'
      });
      window.dispatchEvent(event);
    }, 100);
  }, []);

  /**
   * Handle mouse enter - show popup after short delay (unless pinned)
   */
  const handleMouseEnter = useCallback(() => {
    if (isPinned) return;
    // Clear any pending close timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    // Open after short delay for smoother UX
    hoverTimeoutRef.current = setTimeout(() => {
      setIsOpen(true);
    }, 150);
  }, [isPinned]);

  /**
   * Handle mouse leave - close popup after delay (unless pinned)
   */
  const handleMouseLeave = useCallback(() => {
    if (isPinned) return;
    // Clear any pending open timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    // Close after delay to allow moving to popup content
    hoverTimeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 300);
  }, [isPinned]);

  /**
   * Handle click on trigger - toggle pinned state
   */
  const handleTriggerClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (isPinned) {
      // Clicking when pinned unpins and closes
      setIsPinned(false);
      setIsOpen(false);
    } else {
      // Clicking when not pinned pins it open
      setIsPinned(true);
      setIsOpen(true);
    }
  }, [isPinned]);

  /**
   * Handle popover open change (e.g., clicking outside)
   */
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      // Closing from outside click
      setIsOpen(false);
      setIsPinned(false);
    }
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // Listen for usage updates from main process
    // A null snapshot means the account in use changed to one whose usage isn't known yet: show
    // the loading state until it arrives instead of the previous account's numbers. Its usage may
    // never come (signed out, no subscription usage, rate limited), so stop waiting after a while
    // and show it as unavailable.
    let loadingTimer: ReturnType<typeof setTimeout> | null = null;
    const clearLoadingTimer = () => {
      if (loadingTimer) clearTimeout(loadingTimer);
      loadingTimer = null;
    };
    const unsubscribe = window.electronAPI.onUsageUpdated((snapshot: ClaudeUsageSnapshot | null) => {
      setUsage(snapshot);
      setIsAvailable(!!snapshot);
      setIsLoading(!snapshot);
      clearLoadingTimer();
      if (!snapshot) loadingTimer = setTimeout(() => setIsLoading(false), USAGE_LOADING_TIMEOUT_MS);
    });

    // Listen for all profiles usage updates (to know whether the active profile needs re-auth)
    const unsubscribeAllProfiles = window.electronAPI.onAllProfilesUsageUpdated?.((allProfilesUsage) => {
      // Track if active profile needs re-auth
      const activeProfile = allProfilesUsage.allProfiles.find(p => p.isActive);
      setActiveProfileNeedsReauth(activeProfile?.needsReauthentication ?? false);
    });

    // Request initial usage on mount
    window.electronAPI.requestUsageUpdate().then((result) => {
      setIsLoading(false);
      if (result.success && result.data) {
        setUsage(result.data);
        setIsAvailable(true);
      } else {
        setIsAvailable(false);
      }
    }).catch(() => {
      setIsLoading(false);
      setIsAvailable(false);
    });

    // Request all profiles usage immediately on mount (re-auth state for the active profile)
    window.electronAPI.requestAllProfilesUsage?.().then((result) => {
      if (result.success && result.data) {
        // Track if active profile needs re-auth (even if main usage is unavailable)
        const activeProfile = result.data.allProfiles.find(p => p.isActive);
        if (activeProfile?.needsReauthentication) {
          setActiveProfileNeedsReauth(true);
        }
      }
    }).catch(() => {
      // Silently ignore
    });

    return () => {
      clearLoadingTimer();
      unsubscribe();
      unsubscribeAllProfiles?.();
    };
  }, []);

  // Show loading state - only for Anthropic OAuth accounts awaiting usage data (an account that
  // needs signing in again shows that instead: its usage won't arrive)
  if (isLoading && hasUsageMonitoring && !activeProfileNeedsReauth) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-muted/50 text-muted-foreground">
        <Activity className="h-3.5 w-3.5 motion-safe:animate-pulse" />
        <span className="text-xs font-semibold">{t('common:usage.loading')}</span>
      </div>
    );
  }

  // API profiles (pay as you go): no usage limits to track
  if (activeApiProfile) {
    let providerName = activeApiProfile.baseUrl;
    try {
      providerName = new URL(activeApiProfile.baseUrl).host;
    } catch {
      // Not a URL: show it as entered
    }
    const badgeLabel = t('common:usage.apiKeyBadge');
    const badgeColor = 'text-muted-foreground bg-muted/50 border-border';
    const message = t('common:usage.apiKeyUnknown', { provider: providerName });

    return (
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-md border transition-all hover:opacity-80 ${badgeColor}`}
            aria-label={t('common:usage.usageStatusAriaLabel')}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onClick={handleTriggerClick}
          >
            <Activity className="h-3.5 w-3.5" />
            <span className="text-xs font-semibold">{badgeLabel}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={popoverOffset}
          className="text-xs w-[17rem] p-0 max-h-[80vh] overflow-y-auto"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="p-3 space-y-3">
            <div className="flex items-center gap-1.5 pb-2 border-b">
              <span className="font-semibold text-xs">{t('common:usage.usageBreakdown')}</span>
            </div>
            <div className="flex items-start gap-2.5 py-1">
              <div className="min-w-0 space-y-1">
                <p className="truncate text-xs font-medium">{activeApiProfile.name} · {providerName}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">{message}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleOpenAccounts}
              className="w-full rounded-md bg-muted/60 px-2 py-1.5 text-xs font-medium hover:bg-muted"
            >
              {t('common:usage.manageAccounts')}
            </button>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  // Show unavailable state — but still allow account swapping via popover
  if (!isAvailable || !usage) {
    const needsReauth = activeProfileNeedsReauth;

    return (
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border transition-all hover:opacity-80 ${
              needsReauth
                ? 'bg-red-500/10 border-red-500/20 text-red-500'
                : 'bg-muted/50 text-muted-foreground'
            }`}
            aria-label={needsReauth ? t('common:usage.reauthRequired') : t('common:usage.dataUnavailable')}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onClick={handleTriggerClick}
          >
            {needsReauth ? (
              <>
                <AlertCircle className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold">!</span>
              </>
            ) : (
              <>
                <Activity className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold">{t('common:usage.notAvailable')}</span>
              </>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={popoverOffset}
          className="text-xs w-[17rem] p-0 max-h-[80vh] overflow-y-auto"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="p-3 space-y-3">
            <div className="flex items-center gap-1.5 pb-2 border-b">
              <span className="font-semibold text-xs">{t('common:usage.usageBreakdown')}</span>
            </div>

            {/* Status message */}
            <div className="flex items-start gap-2.5 py-2">
              {needsReauth ? (
                <>
                  <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-red-500">{t('common:usage.reauthRequired')}</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      {t('common:usage.reauthRequiredDescription')}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <p className="text-xs font-medium">{t('common:usage.dataUnavailable')}</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      {t('common:usage.dataUnavailableDescription')}
                    </p>
                  </div>
                </>
              )}
            </div>
        </div>
      </PopoverContent>
      </Popover>
    );
  }

  // Determine colors and labels based on the LIMITING factor (higher of session/weekly)
  const sessionPercent = usage.sessionPercent;
  const weeklyPercent = usage.weeklyPercent;
  const limitingPercent = Math.max(sessionPercent, weeklyPercent);

  // Badge color based on the limiting (higher) percentage
  // Override to red/destructive when re-auth is needed
  const badgeColorClasses = usage.needsReauthentication
    ? 'text-red-500 bg-red-500/10 border-red-500/20'
    : getBadgeColorClasses(limitingPercent);

  // Individual colors for session and weekly in the badge
  const sessionColorClass = getColorClass(sessionPercent);
  const weeklyColorClass = getColorClass(weeklyPercent);

  const maxUsage = Math.max(usage.sessionPercent, usage.weeklyPercent);
  // Show AlertCircle when re-auth needed or high usage
  const Icon = usage.needsReauthentication ? AlertCircle :
    maxUsage >= THRESHOLD_WARNING ? AlertCircle :
    maxUsage >= THRESHOLD_ELEVATED ? TrendingUp :
    Activity;

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          className={`inline-flex h-7 items-center justify-center gap-1 px-2 rounded-md border leading-none transition-all hover:opacity-80 ${badgeColorClasses}`}
          aria-label={t('common:usage.usageStatusAriaLabel')}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={handleTriggerClick}
        >
          <Icon className="h-3.5 w-3.5 flex-shrink-0" />
          {/* Show "!" when re-auth needed, otherwise dual usage display */}
          {usage.needsReauthentication ? (
            <span className="text-xs font-semibold text-red-500" title={t('common:usage.needsReauth')}>
              !
            </span>
          ) : (
            <div className="flex items-center justify-center gap-0.5 text-xs font-semibold font-mono leading-none tabular-nums">
              <span className={sessionColorClass} title={t('common:usage.sessionShort')}>
                {Math.round(sessionPercent)}
              </span>
              {/* Hairline divider (a bold monospace "|" renders too heavy) */}
              <span aria-hidden="true" className="mx-0.5 h-3 w-px bg-muted-foreground/40" />
              <span className={weeklyColorClass} title={t('common:usage.weeklyShort')}>
                {Math.round(weeklyPercent)}
              </span>
            </div>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={popoverOffset}
        className="text-xs w-[17rem] p-0 max-h-[80vh] overflow-y-auto"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Re-auth required prompt - shown when the active profile needs re-authentication */}
        {usage.needsReauthentication ? (
          <div className="p-3 space-y-3">
            <div className="flex items-center gap-1.5 pb-2 border-b">
              <span className="font-semibold text-xs">{t('common:usage.usageBreakdown')}</span>
            </div>
            <div className="py-2 space-y-3">
              <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-destructive/10 border border-destructive/20">
                <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-xs font-medium text-destructive">
                    {t('common:usage.reauthRequired')}
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    {t('common:usage.reauthRequiredDescription')}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleOpenAccounts}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors text-xs font-medium"
              >
                {t('common:usage.reauthButton')}
              </button>
            </div>
          </div>
        ) : (
          <UsageBreakdown usage={usage} open={isOpen} />
        )}
      </PopoverContent>
    </Popover>
  );
}
