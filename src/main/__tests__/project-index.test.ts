/**
 * The project index is the project's CLAUDE.md: Use CLAUDE.md is on while the file is there, and
 * switching it off deletes it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../claude-code/run-text', () => ({ READ_ONLY_TOOLS: [], runClaudeText: vi.fn() }));
vi.mock('../settings-utils', () => ({ readSettingsFile: () => ({}) }));

import { deleteProjectIndex, readProjectIndexInfo } from '../project-index';

let project: string;
const claudeMd = () => path.join(project, 'CLAUDE.md');

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), 'project-index-'));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('the project index', () => {
  it('is nothing until the project has a CLAUDE.md', async () => {
    expect(await readProjectIndexInfo(project)).toBeNull();

    writeFileSync(claudeMd(), '# CLAUDE.md\n\nTwo lines.\n');
    const info = await readProjectIndexInfo(project);
    expect(info?.lines).toBe(4);
    expect(Date.parse(info?.builtAt ?? '')).not.toBeNaN();
  });

  it('switching it off deletes the file and leaves the rest of the project alone', async () => {
    writeFileSync(claudeMd(), '# CLAUDE.md\n');
    writeFileSync(path.join(project, 'README.md'), '# readme\n');

    await deleteProjectIndex(project);

    expect(existsSync(claudeMd())).toBe(false);
    expect(await readProjectIndexInfo(project)).toBeNull();
    expect(existsSync(path.join(project, 'README.md'))).toBe(true);
  });

  it('switching it off for a project that has none is not an error', async () => {
    await expect(deleteProjectIndex(project)).resolves.toBeUndefined();
  });
});
