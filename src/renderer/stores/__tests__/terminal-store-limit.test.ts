import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTerminalStore, getActiveProjectTerminalCount, isProjectTerminal } from '../terminal-store';
import type { TerminalSession } from '../../../main/terminal-session-store';

vi.mock('../../lib/terminal-buffer-manager', () => ({
  terminalBufferManager: { set: vi.fn(), clear: vi.fn(), get: vi.fn() },
}));

const PROJECT = '/home/user/project';
const OTHER = '/home/user/other';

const session = (id: string, projectPath = PROJECT): TerminalSession => ({
  id,
  title: `Terminal ${id}`,
  cwd: projectPath,
  projectPath,
  isCLIMode: false,
  outputBuffer: '',
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
});

beforeEach(() => {
  useTerminalStore.setState({ terminals: [], activeTerminalId: null, maxTerminals: 3 });
});

describe('a window belongs to exactly one project', () => {
  it('never matches another project, and never matches every project', () => {
    const terminal = { projectPath: PROJECT } as Parameters<typeof isProjectTerminal>[0];
    expect(isProjectTerminal(terminal, PROJECT)).toBe(true);
    expect(isProjectTerminal(terminal, OTHER)).toBe(false);
    // A window with no project used to match every grid, which is how the count outgrew the limit
    const projectless = { projectPath: undefined } as Parameters<typeof isProjectTerminal>[0];
    expect(isProjectTerminal(projectless, PROJECT)).toBe(false);
  });
});

describe('the limit', () => {
  it('counts a closing window out, so the grid and the guard agree', () => {
    const store = useTerminalStore.getState();
    store.addTerminal(PROJECT, PROJECT);
    const second = store.addTerminal(PROJECT, PROJECT);
    expect(second).not.toBeNull();
    useTerminalStore.getState().setTerminalStatus(second!.id, 'exited');

    const terminals = useTerminalStore.getState().terminals;
    expect(terminals).toHaveLength(2);
    expect(getActiveProjectTerminalCount(terminals, PROJECT)).toBe(1);
  });

  it('applies to restored windows, not only to new ones', () => {
    const store = useTerminalStore.getState();
    for (const id of ['a', 'b', 'c']) expect(store.addRestoredTerminal(session(id))).not.toBeNull();

    // The fourth would put the project over its limit of 3, so it stays on disk
    expect(store.addRestoredTerminal(session('d'))).toBeNull();
    expect(getActiveProjectTerminalCount(useTerminalStore.getState().terminals, PROJECT)).toBe(3);
  });

  it('is per project, so one project cannot use up another project rooms', () => {
    const store = useTerminalStore.getState();
    for (const id of ['a', 'b', 'c']) store.addRestoredTerminal(session(id, OTHER));

    expect(store.addRestoredTerminal(session('mine'))).not.toBeNull();
    expect(getActiveProjectTerminalCount(useTerminalStore.getState().terminals, PROJECT)).toBe(1);
  });

  it('restores a window it already has without counting it twice', () => {
    const store = useTerminalStore.getState();
    store.addRestoredTerminal(session('a'));
    expect(store.addRestoredTerminal(session('a'))).not.toBeNull();
    expect(getActiveProjectTerminalCount(useTerminalStore.getState().terminals, PROJECT)).toBe(1);
  });
});
