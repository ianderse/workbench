import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { applyProjectMemory, ensureWorktreeProjectMemory, removeProjectMemory } from '../relocation';

const execFileAsync = promisify(execFile);
import { getLearningDir, getMemoryIndexPath, getStashedLearningDir } from '../paths';
import { writeMemories } from '../memory-writer';
import { SELF_LEARNING_RULE_FILENAME } from '../nudge';

vi.mock('../../app-logger', () => ({
  appLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const localSettings = (dir: string) => path.join(dir, '.claude', 'settings.local.json');
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;

let project: string;

beforeEach(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), 'wb-selflearning-'));
  // The switch only exists for an initialized project, which is what `.workbench` marks
  await mkdir(path.join(project, '.workbench'), { recursive: true });
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe('applyProjectMemory', () => {
  it('points autoMemoryDirectory at the project and creates the index', async () => {
    await applyProjectMemory(project);

    expect((await readJson(localSettings(project))).autoMemoryDirectory).toBe(getLearningDir(project));
    expect(existsSync(getMemoryIndexPath(project))).toBe(true);
    expect(existsSync(path.join(project, '.claude', 'rules', SELF_LEARNING_RULE_FILENAME))).toBe(true);
  });

  it('keeps the other keys in an existing settings file', async () => {
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await writeFile(localSettings(project), JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2));

    await applyProjectMemory(project);

    const settings = await readJson(localSettings(project));
    expect(settings.permissions).toEqual({ allow: ['Bash'] });
    expect(settings.autoMemoryDirectory).toBe(getLearningDir(project));
  });

  it('leaves an unparseable settings file alone and reports why', async () => {
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await writeFile(localSettings(project), '{ not json');

    await expect(applyProjectMemory(project)).rejects.toThrow(/could not be read as JSON/);
    expect(await readFile(localSettings(project), 'utf-8')).toBe('{ not json');
  });

  it('adds the memory import to CLAUDE.md exactly once', async () => {
    await writeFile(path.join(project, 'CLAUDE.md'), '# Project\n\nSome instructions.\n');

    await applyProjectMemory(project);
    await applyProjectMemory(project);

    const content = await readFile(path.join(project, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('@.workbench/learning/MEMORY.md');
    expect(content.match(/@\.workbench\/learning\/MEMORY\.md/g)).toHaveLength(1);
    expect(content.startsWith('# Project\n\nSome instructions.\n')).toBe(true);
  });

  it('respects a hand-written import of the same file', async () => {
    const authored = '# Project\n\nMemory: @.workbench/learning/MEMORY.md\n';
    await writeFile(path.join(project, 'CLAUDE.md'), authored);

    await applyProjectMemory(project);

    expect(await readFile(path.join(project, 'CLAUDE.md'), 'utf-8')).toBe(authored);
  });

  it('uses .claude/CLAUDE.md when the project keeps its instructions there', async () => {
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'CLAUDE.md'), '# Project\n');

    await applyProjectMemory(project);

    expect(await readFile(path.join(project, '.claude', 'CLAUDE.md'), 'utf-8')).toContain(
      '@.workbench/learning/MEMORY.md'
    );
  });
});

describe('removeProjectMemory', () => {
  it('undoes the three pieces and keeps what was learned', async () => {
    await writeFile(path.join(project, 'CLAUDE.md'), '# Project\n\nSome instructions.\n');
    await applyProjectMemory(project);
    const learned = path.join(getLearningDir(project), 'indentation-tabs.md');
    await writeFile(learned, 'Always use tabs.\n');

    await removeProjectMemory(project);

    expect(await readJson(localSettings(project))).not.toHaveProperty('autoMemoryDirectory');
    expect(existsSync(path.join(project, '.claude', 'rules', SELF_LEARNING_RULE_FILENAME))).toBe(false);
    expect(await readFile(path.join(project, 'CLAUDE.md'), 'utf-8')).toBe('# Project\n\nSome instructions.\n');
    // The memories themselves are the user's: set aside for the switch coming back, never destroyed
    expect(existsSync(learned)).toBe(false);
    expect(await readFile(path.join(getStashedLearningDir(project), 'indentation-tabs.md'), 'utf-8')).toBe(
      'Always use tabs.\n'
    );
  });

  it('leaves an instruction file whose markers were removed by hand', async () => {
    const authored = '# Project\n\nNo markers here.\n';
    await writeFile(path.join(project, 'CLAUDE.md'), authored);
    await applyProjectMemory(project);
    await writeFile(path.join(project, 'CLAUDE.md'), authored);

    await removeProjectMemory(project);

    expect(await readFile(path.join(project, 'CLAUDE.md'), 'utf-8')).toBe(authored);
  });
});

describe('switching off and on again', () => {
  const memory = (name: string, text: string) => ({ name, text });

  /** A project whose .workbench is untracked, which is the usual case (Workbench gitignores it) */
  const writeMemories = async (...files: { name: string; text: string }[]) => {
    await applyProjectMemory(project);
    for (const file of files) await writeFile(path.join(getLearningDir(project), file.name), file.text);
    await writeFile(
      getMemoryIndexPath(project),
      files.map((f) => `- [${f.name}](${f.name}) — hook\n`).join('')
    );
  };

  it('sets the memories aside instead of orphaning them, and restores them on the way back', async () => {
    await writeMemories(memory('tabs.md', 'Use tabs.\n'), memory('typecheck.md', 'Run typecheck.\n'));

    await removeProjectMemory(project);
    // Nothing points at the learning directory while the switch is off, so it must not be left there
    expect(existsSync(getLearningDir(project))).toBe(false);
    expect(existsSync(path.join(getStashedLearningDir(project), 'tabs.md'))).toBe(true);

    await applyProjectMemory(project);
    expect(await readFile(path.join(getLearningDir(project), 'tabs.md'), 'utf-8')).toBe('Use tabs.\n');
    expect(await readFile(path.join(getLearningDir(project), 'typecheck.md'), 'utf-8')).toBe('Run typecheck.\n');
    expect(existsSync(getStashedLearningDir(project))).toBe(false);

    const index = await readFile(getMemoryIndexPath(project), 'utf-8');
    expect(index).toContain('](tabs.md)');
    expect(index).toContain('](typecheck.md)');
  });

  it('merges the restored index with memories learned in the meantime, without duplicates', async () => {
    await writeMemories(memory('tabs.md', 'Use tabs.\n'));
    await removeProjectMemory(project);

    // While off, Claude Code learns elsewhere; the user may also have put something back by hand
    await mkdir(getLearningDir(project), { recursive: true });
    await writeFile(path.join(getLearningDir(project), 'naming.md'), 'Name things well.\n');
    await writeFile(getMemoryIndexPath(project), '- [naming.md](naming.md) — hook\n');

    await applyProjectMemory(project);

    const index = await readFile(getMemoryIndexPath(project), 'utf-8');
    expect(index.match(/\]\(naming\.md\)/g)).toHaveLength(1);
    expect(index).toContain('](tabs.md)');
    expect(existsSync(path.join(getLearningDir(project), 'naming.md'))).toBe(true);
  });

  it('keeps both files when a name exists on both sides', async () => {
    await writeMemories(memory('tabs.md', 'Stashed version.\n'));
    await removeProjectMemory(project);
    await mkdir(getLearningDir(project), { recursive: true });
    await writeFile(path.join(getLearningDir(project), 'tabs.md'), 'Newer version.\n');

    await applyProjectMemory(project);

    expect(await readFile(path.join(getLearningDir(project), 'tabs.md'), 'utf-8')).toBe('Newer version.\n');
    expect(await readFile(path.join(getLearningDir(project), 'tabs.restored.md'), 'utf-8')).toBe('Stashed version.\n');
  });

  it('leaves committed memories in place rather than moving tracked files', async () => {
    await writeMemories(memory('tabs.md', 'Use tabs.\n'));
    await execFileAsync('git', ['init', '-q'], { cwd: project });
    await execFileAsync('git', ['add', '-f', '.workbench/learning'], { cwd: project });

    await removeProjectMemory(project);

    // The user committed these deliberately: a settings toggle does not delete tracked files
    expect(existsSync(path.join(getLearningDir(project), 'tabs.md'))).toBe(true);
    expect(existsSync(getStashedLearningDir(project))).toBe(false);
  });
});

describe('guards', () => {
  it('refuses a project that is not initialized, rather than creating .workbench for it', async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), 'wb-bare-'));
    try {
      // .workbench existing is what marks a project initialized, so creating it here would lie
      await expect(applyProjectMemory(bare)).rejects.toThrow(/not initialized/);
      expect(existsSync(path.join(bare, '.workbench'))).toBe(false);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('keeps the index present while it holds no memories, so the CLAUDE.md import resolves', async () => {
    await applyProjectMemory(project);
    await writeMemories(project, []);

    const index = await readFile(getMemoryIndexPath(project), 'utf-8');
    expect(index.trim().startsWith('<!--')).toBe(true);
  });

  it("carries the build's stats aside and back, so re-enabling is not a fresh start", async () => {
    await applyProjectMemory(project);
    await writeFile(path.join(getLearningDir(project), 'tabs.md'), 'Use tabs.\n');
    const stats = path.join(getLearningDir(project), 'index.json');
    await writeFile(stats, JSON.stringify({ memories: 1, sessionsScanned: 9, builtAt: '2026-10-18T00:00:00.000Z' }));

    await removeProjectMemory(project);
    expect(existsSync(path.join(getStashedLearningDir(project), 'index.json'))).toBe(true);

    await applyProjectMemory(project);
    // Without this the project looks unindexed and every past session gets scanned again
    const restored = JSON.parse(await readFile(stats, 'utf-8')) as { sessionsScanned: number };
    expect(restored.sessionsScanned).toBe(9);
  });
});

describe('ensureWorktreeProjectMemory', () => {
  it('points a worktree at the primary checkout, not at itself', async () => {
    const worktree = path.join(project, '.workbench', 'worktrees', 'tasks', '001-demo');
    await mkdir(worktree, { recursive: true });

    await ensureWorktreeProjectMemory(worktree, project);

    const settings = await readJson(localSettings(worktree));
    expect(settings.autoMemoryDirectory).toBe(getLearningDir(project));
    expect(settings.autoMemoryDirectory).not.toBe(getLearningDir(worktree));
  });
});
