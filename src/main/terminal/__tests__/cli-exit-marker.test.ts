import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', async (importOriginal) => ({ ...(await importOriginal<object>()), isWindows: () => false }));

import { CLI_EXIT_MARKER, shouldCloseOnCliExit } from '../cli-integration-handler';

describe('shouldCloseOnCliExit', () => {
  it('closes when the marker appears, also split across output chunks', () => {
    const terminal: { cliRestarting?: boolean; cliExitTail?: string } = {};
    expect(shouldCloseOnCliExit(terminal, 'bye\r\n')).toBe(false);
    expect(shouldCloseOnCliExit(terminal, `prompt$ ${CLI_EXIT_MARKER}`)).toBe(true);

    const split = {};
    expect(shouldCloseOnCliExit(split, CLI_EXIT_MARKER.slice(0, 10))).toBe(false);
    expect(shouldCloseOnCliExit(split, CLI_EXIT_MARKER.slice(10))).toBe(true);
  });

  it('ignores the typed command, which shows the marker as escaped text', () => {
    const echoed = "claude; printf '\\033]777;workbench-cli-exit\\007'\r\n";
    expect(shouldCloseOnCliExit({}, echoed)).toBe(false);
  });

  it('keeps the window open once when the app restarts the CLI', () => {
    const terminal = { cliRestarting: true };
    expect(shouldCloseOnCliExit(terminal, CLI_EXIT_MARKER)).toBe(false);
    expect(terminal.cliRestarting).toBe(false);
    expect(shouldCloseOnCliExit(terminal, CLI_EXIT_MARKER)).toBe(true);
  });
});
