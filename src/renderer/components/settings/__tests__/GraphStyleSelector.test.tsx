/**
 * @vitest-environment jsdom
 */
/**
 * Graph style row (Appearance): an icon-only Plain / Colorful switch that applies right away.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { TooltipProvider } from '../../ui/tooltip';
import { GraphStyleSelector } from '../GraphStyleSelector';
import type { AppSettings } from '../../../../shared/types';

// jsdom has no matchMedia or ResizeObserver (used by SegmentedControl)
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as unknown as typeof ResizeObserver;
}

const updateSettings = vi.fn();
vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: (selector: (state: { updateSettings: typeof updateSettings }) => unknown) =>
    selector({ updateSettings })
}));

const renderRow = (settings: Partial<AppSettings>, onSettingsChange = vi.fn()) => {
  render(
    <TooltipProvider>
      <GraphStyleSelector settings={settings as AppSettings} onSettingsChange={onSettingsChange} />
    </TooltipProvider>
  );
  return onSettingsChange;
};

describe('GraphStyleSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the Graph style row with Plain and Colorful, plain by default', () => {
    renderRow({ theme: 'dark' });
    expect(screen.getByText('Graph style')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Plain' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Colorful' })).toHaveAttribute('aria-checked', 'false');
  });

  it('shows the saved style', () => {
    renderRow({ theme: 'dark', graphStyle: 'colorful' });
    expect(screen.getByRole('radio', { name: 'Colorful' })).toHaveAttribute('aria-checked', 'true');
  });

  it('saves the style and applies it right away', () => {
    const onSettingsChange = renderRow({ theme: 'dark', graphStyle: 'colorful' });
    fireEvent.click(screen.getByRole('radio', { name: 'Plain' }));
    expect(onSettingsChange).toHaveBeenCalledWith({ theme: 'dark', graphStyle: 'plain' });
    expect(updateSettings).toHaveBeenCalledWith({ graphStyle: 'plain' });
  });
});
