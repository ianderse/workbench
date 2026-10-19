import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ Menu: {}, Tray: class {}, nativeImage: {} }));
vi.mock('../app-language', () => ({ getAppLanguage: () => 'en' }));

import { buildTrayMenuTemplate, formatPlanLabel, allowWindowClose, isWindowCloseAllowed } from '../app-tray';

const actions = { onShowApp: vi.fn(), onFocusWindow: vi.fn(), onQuit: vi.fn() };
const labelsOf = (template: Electron.MenuItemConstructorOptions[]) =>
  template.map((item) => (item.type === 'separator' ? '---' : `${item.label}${item.enabled === false ? ' (disabled)' : ''}`));

describe('buildTrayMenuTemplate', () => {
  it('shows the app entry, plan, session usage and quit', () => {
    expect(labelsOf(buildTrayMenuTemplate({ planName: 'max', sessionPercent: 19.4 }, actions))).toEqual([
      'Show App',
      '---',
      'Max plan (disabled)',
      'Usage: 19% (disabled)',
      '---',
      'Quit',
    ]);
  });

  it('skips the plan when unknown and keeps usage', () => {
    expect(labelsOf(buildTrayMenuTemplate({ planName: null, sessionPercent: 0 }, actions))).toEqual([
      'Show App', '---', 'Usage: 0% (disabled)', '---', 'Quit',
    ]);
  });

  it('collapses to Show App / Quit when nothing is known', () => {
    expect(labelsOf(buildTrayMenuTemplate({ planName: null, sessionPercent: null }, actions))).toEqual(['Show App', '---', 'Quit']);
  });

  it('lists the open project windows instead of "Show App"', () => {
    const windows = [
      { windowId: 1, projectName: 'proj_1' },
      { windowId: 2, projectName: 'proj_2' },
      { windowId: 3, projectName: null },
    ];
    expect(labelsOf(buildTrayMenuTemplate({ planName: null, sessionPercent: null }, actions, windows))).toEqual([
      'proj_1', 'proj_2', 'No project', '---', 'Quit',
    ]);
  });

  it('keeps "Show App" while a single window is open', () => {
    const windows = [{ windowId: 1, projectName: 'proj_1' }];
    expect(labelsOf(buildTrayMenuTemplate({ planName: null, sessionPercent: null }, actions, windows))).toEqual([
      'Show App', '---', 'Quit',
    ]);
  });

  it('focuses the window a project entry belongs to', () => {
    const template = buildTrayMenuTemplate({ planName: null, sessionPercent: null }, actions, [
      { windowId: 7, projectName: 'proj_1' },
      { windowId: 9, projectName: 'proj_2' },
    ]);
    (template[1].click as () => void)();
    expect(actions.onFocusWindow).toHaveBeenCalledWith(9);
  });

  it('wires the actions', () => {
    const template = buildTrayMenuTemplate({ planName: null, sessionPercent: null }, actions);
    (template[0].click as () => void)();
    (template[template.length - 1].click as () => void)();
    expect(actions.onShowApp).toHaveBeenCalled();
    expect(actions.onQuit).toHaveBeenCalled();
  });
});

describe('formatPlanLabel', () => {
  it('capitalizes the subscription type', () => {
    expect(formatPlanLabel('pro')).toBe('Pro plan');
  });
});

describe('allowWindowClose', () => {
  it('lets the window close for real once set', () => {
    expect(isWindowCloseAllowed()).toBe(false);
    allowWindowClose();
    expect(isWindowCloseAllowed()).toBe(true);
  });
});
