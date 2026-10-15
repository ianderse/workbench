import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { migrateProjectDataDirs } from '../data-dir-migration';

describe('migrateProjectDataDirs', () => {
  let project: string;
  const data = (...parts: string[]) => path.join(project, '.workbench', ...parts);

  beforeEach(() => {
    project = mkdtempSync(path.join(os.tmpdir(), 'data-dirs-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('renames specs, memory and insights (and worktree task copies) to tasks, knowledge and chats', async () => {
    mkdirSync(data('specs', '001-a'), { recursive: true });
    writeFileSync(data('specs', '001-a', 'task_metadata.json'), '{}');
    mkdirSync(data('memory', 'graphify-out'), { recursive: true });
    mkdirSync(data('insights', 'sessions'), { recursive: true });
    mkdirSync(data('tasks'), { recursive: true }); // empty folder made by a newer initializer
    mkdirSync(data('worktrees', 'tasks', '001-a', '.workbench', 'specs', '001-a'), { recursive: true });

    await migrateProjectDataDirs(project);

    expect(readFileSync(data('tasks', '001-a', 'task_metadata.json'), 'utf-8')).toBe('{}');
    expect(existsSync(data('knowledge', 'graphify-out'))).toBe(true);
    expect(existsSync(data('chats', 'sessions'))).toBe(true);
    expect(existsSync(data('worktrees', 'tasks', '001-a', '.workbench', 'tasks', '001-a'))).toBe(true);
    for (const legacy of ['specs', 'memory', 'insights']) expect(existsSync(data(legacy))).toBe(false);
  });

  it('never overwrites a new folder that already has data', async () => {
    mkdirSync(data('specs', '001-old'), { recursive: true });
    mkdirSync(data('tasks', '002-new'), { recursive: true });

    await migrateProjectDataDirs(project);

    expect(existsSync(data('specs', '001-old'))).toBe(true);
    expect(existsSync(data('tasks', '002-new'))).toBe(true);
  });

  it('does nothing for a project without .workbench', async () => {
    await expect(migrateProjectDataDirs(project)).resolves.toBeUndefined();
    expect(existsSync(data())).toBe(false);
  });
});
