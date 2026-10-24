/**
 * buildCdCommand and buildUnsetEnvPrefix: the syntax follows the terminal's shell kind, and the
 * platform's default shell when the terminal doesn't say
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const platform = vi.hoisted(() => ({ windows: false }));
vi.mock('../../platform', () => ({ isWindows: () => platform.windows }));

import { buildCdCommand, buildUnsetEnvPrefix, defaultShellKind, escapePowerShellArg } from '../shell-escape';

beforeEach(() => {
  platform.windows = false;
});

describe('buildCdCommand', () => {
  it('is empty without a path', () => {
    expect(buildCdCommand(undefined, 'posix')).toBe('');
  });

  it('quotes for POSIX shells', () => {
    expect(buildCdCommand("/tmp/it's here", 'posix')).toBe("cd '/tmp/it'\\''s here' && ");
  });

  it('changes drives with cmd.exe syntax', () => {
    expect(buildCdCommand('C:\\My "Projects"\\100%', 'cmd')).toBe('cd /d "C:\\My ""Projects""\\100%%" && ');
  });

  it('uses Set-Location for PowerShell, ending the line when the folder is missing (no && in 5.1)', () => {
    expect(buildCdCommand('C:\\repo', 'powershell')).toBe("Set-Location -LiteralPath 'C:\\repo' -ErrorAction Stop; ");
    expect(buildCdCommand("C:\\O'Brien\\[x] $env:A", 'powershell')).toBe(
      "Set-Location -LiteralPath 'C:\\O''Brien\\[x] $env:A' -ErrorAction Stop; "
    );
  });

  it("uses the platform's default shell when no kind is given", () => {
    expect(defaultShellKind()).toBe('posix');
    expect(buildCdCommand('/repo')).toBe("cd '/repo' && ");
    platform.windows = true;
    expect(defaultShellKind()).toBe('powershell');
    expect(buildCdCommand('C:\\repo')).toBe("Set-Location -LiteralPath 'C:\\repo' -ErrorAction Stop; ");
  });
});

describe('escapePowerShellArg', () => {
  it('single-quotes, so nothing inside expands', () => {
    expect(escapePowerShellArg('C:\\Program Files\\x')).toBe("'C:\\Program Files\\x'");
    expect(escapePowerShellArg('$env:PATH; $(rm) `n')).toBe("'$env:PATH; $(rm) `n'");
  });

  it('doubles single quotes, typographic ones included', () => {
    expect(escapePowerShellArg("it's")).toBe("'it''s'");
    expect(escapePowerShellArg('a\u2019b\u2018c')).toBe("'a\u2019\u2019b\u2018\u2018c'");
  });

  it('drops line breaks, which would submit the typed line early', () => {
    expect(escapePowerShellArg('a\r\nb\nc')).toBe("'abc'");
  });
});

describe('buildUnsetEnvPrefix', () => {
  it('removes the variable for the command in each shell', () => {
    expect(buildUnsetEnvPrefix('CLAUDE_CONFIG_DIR', 'posix')).toBe('env -u CLAUDE_CONFIG_DIR ');
    expect(buildUnsetEnvPrefix('CLAUDE_CONFIG_DIR', 'cmd')).toBe('set "CLAUDE_CONFIG_DIR=" && ');
    // Not `$env:X = $null`, which Windows PowerShell 5.1 leaves behind as an empty string
    expect(buildUnsetEnvPrefix('CLAUDE_CONFIG_DIR', 'powershell')).toBe(
      'Remove-Item Env:\\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; '
    );
  });

  it("uses the platform's default shell when no kind is given", () => {
    expect(buildUnsetEnvPrefix('CLAUDE_CONFIG_DIR')).toBe('env -u CLAUDE_CONFIG_DIR ');
    platform.windows = true;
    expect(buildUnsetEnvPrefix('CLAUDE_CONFIG_DIR')).toBe(
      'Remove-Item Env:\\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; '
    );
  });
});
