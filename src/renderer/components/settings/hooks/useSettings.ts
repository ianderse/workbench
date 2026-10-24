import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore, saveSettings as saveSettingsToStore, loadSettings as loadSettingsFromStore } from '../../../stores/settings-store';
import type { AppSettings } from '../../../../shared/types';

/**
 * Custom hook for managing application settings
 * Provides state management and save/load functionality
 *
 * Theme and UI scale changes are applied immediately for live preview. If the user
 * cancels without saving, call revertTheme() to restore the original values.
 */
export function useSettings() {
  const currentSettings = useSettingsStore((state) => state.settings);
  const updateStoreSettings = useSettingsStore((state) => state.updateSettings);
  const [settings, setSettings] = useState<AppSettings>(currentSettings);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Store the original theme settings when the hook mounts (dialog opens)
  // This allows us to revert if the user cancels
  const originalThemeRef = useRef<{
    theme: AppSettings['theme'];
    colorTheme: AppSettings['colorTheme'];
  }>({
    theme: currentSettings.theme,
    colorTheme: currentSettings.colorTheme
  });

  /**
   * Follow the store, one key at a time.
   *
   * Some rows write straight to the store so the change can be seen at once - the theme and the UI
   * scale for live preview, the shell and the interface font because other parts of the app read
   * them - while the dialog's own edits sit in this state until the autosave debounce fires.
   * Replacing this state with the store's whenever the store changed therefore threw away whatever
   * the user had edited but not yet saved: picking a shell right after changing a dialog-only row
   * silently lost that row. Only the keys the store itself just changed are taken, so a live
   * preview and a pending edit no longer compete for the same state.
   */
  const lastStoreSettings = useRef<AppSettings>(currentSettings);
  useEffect(() => {
    const previous = lastStoreSettings.current;
    lastStoreSettings.current = currentSettings;
    if (previous === currentSettings) return;
    const changed = (Object.keys(currentSettings) as Array<keyof AppSettings>).filter(
      (key) => currentSettings[key] !== previous[key]
    );
    if (changed.length === 0) return;
    setSettings((local) => {
      const next = { ...local };
      for (const key of changed) next[key] = currentSettings[key] as never;
      return next;
    });
  }, [currentSettings]);

  // Load settings on mount
  useEffect(() => {
    loadSettingsFromStore();
  }, []);

  // Capture original theme when store values change (for revert on cancel)
  useEffect(() => {
    originalThemeRef.current = {
      theme: currentSettings.theme,
      colorTheme: currentSettings.colorTheme
    };
  }, [currentSettings.colorTheme, currentSettings.theme]);

  const saveSettings = async () => {
    setIsSaving(true);
    setError(null);

    try {
      const success = await saveSettingsToStore(settings);
      if (success) {
        // Apply theme immediately
        applyTheme(settings.theme);
        return true;
      } else {
        setError('Failed to save settings');
        return false;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const applyTheme = (theme: 'light' | 'dark' | 'system') => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else if (theme === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      // System preference
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    }
  };

  const updateSettings = (partial: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  };

  /**
   * Revert theme to the original values (before any preview changes).
   * Call this when the user cancels the settings dialog without saving.
   */
  const revertTheme = useCallback(() => {
    const original = originalThemeRef.current;
    updateStoreSettings({
      theme: original.theme,
      colorTheme: original.colorTheme
    });
  }, [updateStoreSettings]);

  /**
   * Capture the current theme as the new "original" after successful save.
   * This updates the reference point for future reverts.
   */
  const commitTheme = useCallback(() => {
    originalThemeRef.current = {
      theme: settings.theme,
      colorTheme: settings.colorTheme
    };
  }, [settings.theme, settings.colorTheme]);

  return {
    settings,
    setSettings,
    updateSettings,
    isSaving,
    error,
    saveSettings,
    applyTheme,
    revertTheme,
    commitTheme
  };
}
