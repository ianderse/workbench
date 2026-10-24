/**
 * @vitest-environment jsdom
 */
/**
 * The settings dialog keeps the user's edits in its own state until the autosave debounce fires,
 * while a few rows write straight to the store so the change takes effect at once (theme and UI
 * scale for live preview, the shell and the interface font because the rest of the app reads them).
 * Following the store wholesale threw the pending edits away; it is followed one key at a time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../../../../stores/settings-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../stores/settings-store')>();
  return { ...actual, saveSettings: vi.fn(async () => true), loadSettings: vi.fn(async () => undefined) };
});

import { useSettingsStore } from '../../../../stores/settings-store';
import { useSettings } from '../useSettings';

const initial = useSettingsStore.getState().settings;

beforeEach(() => {
  useSettingsStore.setState({ settings: initial });
  // jsdom has no matchMedia, which the hook consults for the "system" theme
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({ matches: false }) as MediaQueryList,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSettings following the store', () => {
  it('keeps a pending dialog edit when another row writes to the store', () => {
    const { result } = renderHook(() => useSettings());

    // Edited in the dialog only, not saved yet
    act(() => result.current.updateSettings({ sidebarCollapsed: true }));
    expect(result.current.settings.sidebarCollapsed).toBe(true);

    // A live-preview row writes straight to the store
    act(() => useSettingsStore.getState().updateSettings({ theme: 'dark' }));

    expect(result.current.settings.theme).toBe('dark');
    expect(result.current.settings.sidebarCollapsed).toBe(true);
  });

  it('takes a value the store changed, even when the dialog had edited it', () => {
    const { result } = renderHook(() => useSettings());

    act(() => result.current.updateSettings({ theme: 'light' }));
    act(() => useSettingsStore.getState().updateSettings({ theme: 'dark' }));

    // The store is the one that just spoke about this key, so its value wins
    expect(result.current.settings.theme).toBe('dark');
  });
});
