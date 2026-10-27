/**
 * The tick loop's reading of the scene width.
 *
 * Clawd walks inside whatever the scene reports, and a width of zero is ambiguous: the first
 * ticks run before the scene has measured itself, while a popover narrower than he is reports a
 * real width that simply leaves him no room to walk. The timers are faked so the loop ticks only
 * when a test asks it to.
 *
 * Also: what a click does with the whole scene standing still for reduced motion. Less animation
 * nobody set off does not mean a mascot that ignores being clicked, so petting still answers -
 * with a heart, or his soul once the limit is used up - held in place rather than floating up.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useClawd } from '../useClawd';
import { MASCOT_W } from '../sprite';
import { CLASSIC_SKIN } from '../skins';

/** An idle scene of the given width, with plenty of the limit left */
function scene(span: number) {
  return {
    sessionPercent: 10,
    busy: 0,
    waiting: 0,
    total: 1,
    span,
    pointerX: null,
    active: true,
    skin: CLASSIC_SKIN,
  };
}

/** What the OS is asking for, as the hook reads it */
function reduceMotion(on: boolean): void {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: on && media.includes('prefers-reduced-motion'),
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useClawd', () => {
  it('draws him at the left edge when the scene is narrower than he is', () => {
    vi.useFakeTimers();

    const { result, unmount } = renderHook(() => useClawd(scene(MASCOT_W - 10)));

    // There is one position such a scene can hold him in, and he belongs in it rather than nowhere
    expect(result.current.render).not.toBeNull();
    expect(result.current.render?.x).toBe(0);

    unmount();
  });

  it('waits for a scene that has not reported its width yet', () => {
    vi.useFakeTimers();

    const { result, unmount } = renderHook(() => useClawd(scene(0)));

    expect(result.current.render).toBeNull();

    unmount();
  });

  it('answers a click with a still heart under reduced motion', () => {
    vi.useFakeTimers();
    reduceMotion(true);

    const { result, unmount } = renderHook(() => useClawd(scene(200)));

    // He is standing there with nothing over him until he is petted
    expect(result.current.render?.love).toBeNull();

    act(() => result.current.pet());

    expect(result.current.render?.love).not.toBeNull();
    // Held in place over the middle of him, not on its way anywhere
    expect(result.current.render?.love?.x).toBeCloseTo((200 - MASCOT_W) / 2 + MASCOT_W / 2 - 5);
    expect(result.current.render?.love?.opacity).toBe(1);

    // And then the scene goes back to resting
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(result.current.render?.love).toBeNull();

    unmount();
  });

  it('lets the soul out on a click with the limit used up, under reduced motion', () => {
    vi.useFakeTimers();
    reduceMotion(true);

    const { result, unmount } = renderHook(() => useClawd({ ...scene(200), sessionPercent: 100 }));

    expect(result.current.render?.soul).toBeNull();

    act(() => result.current.pet());

    expect(result.current.render?.soul?.rects.length).toBeGreaterThan(0);
    // The spirit is out and hanging still: no heart, and nothing moves it from frame to frame
    expect(result.current.render?.love).toBeNull();

    unmount();
  });
});
