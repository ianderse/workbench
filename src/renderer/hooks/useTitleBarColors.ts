import { useEffect } from 'react';
import { IS_DEV_BUILD } from '../lib/title-bar';

/** `rgb(…)`/`rgba(…)` from getComputedStyle → `#rrggbb` (alpha ignored), or null if unparseable */
export function cssColorToHex(color: string): string | null {
  const match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(color.trim());
  if (!match) return null;
  return `#${match.slice(1, 4).map((c) => Number(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Keep the Windows/Linux window controls (drawn by Electron over the top-right corner) in the
 * page's colors: re-sends the body background and text colors whenever the theme
 * (`data-theme`) or appearance mode (`dark` class) on <html> changes. Development builds swap the
 * two, matching the DEVELOPMENT BUILD bar the controls sit on.
 */
export function useTitleBarColors(): void {
  useEffect(() => {
    const root = document.documentElement;
    let lastSent = '';

    const sync = () => {
      const style = getComputedStyle(document.body);
      const background = cssColorToHex(style.backgroundColor);
      const text = cssColorToHex(style.color);
      const [color, symbolColor] = IS_DEV_BUILD ? [text, background] : [background, text];
      if (!color || !symbolColor) return;
      const key = `${color}|${symbolColor}`;
      if (key === lastSent) return;
      lastSent = key;
      window.electronAPI.setTitleBarColors({ color, symbolColor });
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);
}
