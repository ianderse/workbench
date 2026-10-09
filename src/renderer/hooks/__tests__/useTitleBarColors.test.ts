/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { cssColorToHex, useTitleBarColors } from '../useTitleBarColors';

// Vitest runs with import.meta.env.DEV set; each test picks the build type it checks
const build = vi.hoisted(() => ({ isDev: false }));
vi.mock('../../lib/title-bar', () => ({
  get IS_DEV_BUILD() {
    return build.isDev;
  },
}));

describe('cssColorToHex', () => {
  it('converts rgb/rgba to hex and ignores alpha', () => {
    expect(cssColorToHex('rgb(21, 21, 21)')).toBe('#151515');
    expect(cssColorToHex('rgba(240, 239, 236, 0.5)')).toBe('#f0efec');
  });

  it('returns null for unparseable colors', () => {
    expect(cssColorToHex('transparent')).toBeNull();
  });
});

describe('useTitleBarColors', () => {
  const setTitleBarColors = vi.fn();

  beforeEach(() => {
    setTitleBarColors.mockClear();
    (window as unknown as { electronAPI: unknown }).electronAPI = { setTitleBarColors };
    document.body.style.backgroundColor = 'rgb(252, 252, 251)';
    document.body.style.color = 'rgb(11, 11, 11)';
    document.documentElement.className = '';
    build.isDev = false;
  });

  it('sends the page colors on mount and again when the appearance mode changes', async () => {
    renderHook(() => useTitleBarColors());
    expect(setTitleBarColors).toHaveBeenLastCalledWith({ color: '#fcfcfb', symbolColor: '#0b0b0b' });

    document.body.style.backgroundColor = 'rgb(21, 21, 21)';
    document.body.style.color = 'rgb(240, 239, 236)';
    document.documentElement.classList.add('dark');
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the MutationObserver fire

    expect(setTitleBarColors).toHaveBeenLastCalledWith({ color: '#151515', symbolColor: '#f0efec' });
  });

  it('swaps the colors in development builds, matching the DEVELOPMENT BUILD bar', () => {
    build.isDev = true;
    renderHook(() => useTitleBarColors());
    expect(setTitleBarColors).toHaveBeenLastCalledWith({ color: '#0b0b0b', symbolColor: '#fcfcfb' });
  });

  it('does not resend unchanged colors', async () => {
    renderHook(() => useTitleBarColors());
    document.documentElement.setAttribute('data-theme', 'default');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setTitleBarColors).toHaveBeenCalledTimes(1);
  });
});
