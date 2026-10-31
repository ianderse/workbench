/**
 * A window whose shell ends on its own (`exit`, or `/exit` in an agent window) closes, so it must
 * not come back on the next launch; one destroyed or replaced on purpose keeps its own handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRemovePersistedSession = vi.fn();
vi.mock('../pty-manager', () => ({}));
vi.mock('../session-handler', () => ({ removePersistedSession: (...args: unknown[]) => mockRemovePersistedSession(...args) }));
vi.mock('../../platform', () => ({ isWindows: () => false }));
vi.mock('../../platform/shell-runtime', () => ({}));
vi.mock('../../graphify-paths', () => ({}));
vi.mock('../../self-improve/setting', () => ({}));
vi.mock('../../ipc-handlers/utils', () => ({ safeSendToRenderer: vi.fn() }));

import { handleTerminalExit } from '../terminal-lifecycle';
import type { TerminalProcess } from '../types';

const terminal = (id: string) => ({ id, projectPath: '/project' }) as unknown as TerminalProcess;

beforeEach(() => {
  mockRemovePersistedSession.mockClear();
});

describe('handleTerminalExit', () => {
  it('removes the saved session of a shell that ended on its own', () => {
    const exited = terminal('term-1');
    handleTerminalExit(exited, new Map([['term-1', exited]]));
    expect(mockRemovePersistedSession).toHaveBeenCalledWith(exited);
  });

  it('leaves a destroyed terminal alone (its session was handled when it was destroyed)', () => {
    handleTerminalExit(terminal('term-1'), new Map());
    expect(mockRemovePersistedSession).not.toHaveBeenCalled();
  });

  it('leaves the session of a replacement with the same id alone', () => {
    const replacement = terminal('term-1');
    handleTerminalExit(terminal('term-1'), new Map([['term-1', replacement]]));
    expect(mockRemovePersistedSession).not.toHaveBeenCalled();
  });
});
