import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  applyProjectMemory,
  ensureWorktreeProjectMemory,
  removeProjectMemory,
  repairProjectMemorySetting,
} from '../relocation';

const execFileAsync = promisify(execFile);
import { getCompengDir, getMemoryIndexPath, getStashedCompengDir } from '../paths';
import { writeMemories } from '../memory-writer';
import { SELF_IMPROVE_MEMORY_FILENAME } from '../nudge';

vi.mock('../../app-logger', () => ({
  appLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

/**
 * The shell runtime the app runs its tools in, which decides how the setting spells the memory
 * directory. The translation only has to be recognizable, not real: the tests assert that the
 * value is the one this runtime would write, whichever that is.
 */
const runtime = vi.hoisted(() => ({
  wsl: false,
  toRuntimePath: (p: string) => `/mnt/wsl${p}`,
}));

// Only these two functions are replaced: the rest of both modules stays real, because the git this
// file's other tests run reaches the runtime layer through them
vi.mock('../../platform/claude-home', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/claude-home')>()),
  isClaudeHomeInWsl: () => runtime.wsl,
}));
vi.mock('../../platform/shell-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/shell-runtime')>()),
  toRuntimePath: runtime.toRuntimePath,
}));

const localSettings = (dir: string) => path.join(dir, '.claude', 'settings.local.json');
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;

let project: string;

beforeEach(async () => {
  runtime.wsl = false;
  project = await mkdtemp(path.join(os.tmpdir(), 'wb-selfimprove-'));
  // The switch only exists for an initialized project, which is what `.workbench` marks
  await mkdir(path.join(project, '.workbench'), { recursive: true });
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe('applyProjectMemory', () => {
  it('points autoMemoryDirectory at the project and creates the index', async () => {
    await applyProjectMemory(project);

    expect((await readJson(localSettings(project))).autoMemoryDirectory).toBe(getCompengDir(project));
    expect(existsSync(getMemoryIndexPath(project))).toBe(true);
    expect(existsSync(path.join(project, '.claude', SELF_IMPROVE_MEMORY_FILENAME))).toBe(true);
  });

  it('keeps the other keys in an existing settings file', async () => {
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await writeFile(localSettings(project), JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2));

    await applyProjectMemory(project);

    const settings = await readJson(localSettings(project));
    expect(settings.permissions).toEqual({ allow: ['Bash'] });
    expect(settings.autoMemoryDirectory).toBe(getCompengDir(project));
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
    expect(content).toContain('@.workbench/compeng/MEMORY.md');
    expect(content.match(/@\.workbench\/compeng\/MEMORY\.md/g)).toHaveLength(1);
    expect(content.startsWith('# Project\n\nSome instructions.\n')).toBe(true);
  });

  it('respects a hand-written import of the same file', async () => {
    const authored = '# Project\n\nMemory: @.workbench/compeng/MEMORY.md\n';
    await writeFile(path.join(project, 'CLAUDE.md'), authored);

    await applyProjectMemory(project);

    expect(await readFile(path.join(project, 'CLAUDE.md'), 'utf-8')).toBe(authored);
  });

  it('uses .claude/CLAUDE.md when the project keeps its instructions there', async () => {
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'CLAUDE.md'), '# Project\n');

    await applyProjectMemory(project);

    expect(await readFile(path.join(project, '.claude', 'CLAUDE.md'), 'utf-8')).toContain(
      '@.workbench/compeng/MEMORY.md'
    );
  });
});

describe('removeProjectMemory', () => {
  it('undoes the three pieces and keeps what was learned', async () => {
    await writeFile(path.join(project, 'CLAUDE.md'), '# Project\n\nSome instructions.\n');
    await applyProjectMemory(project);
    const learned = path.join(getCompengDir(project), 'indentation-tabs.md');
    await writeFile(learned, 'Always use tabs.\n');

    await removeProjectMemory(project);

    expect(await readJson(localSettings(project))).not.toHaveProperty('autoMemoryDirectory');
    expect(existsSync(path.join(project, '.claude', SELF_IMPROVE_MEMORY_FILENAME))).toBe(false);
    expect(await readFile(path.join(project, 'CLAUDE.md'), 'utf-8')).toBe('# Project\n\nSome instructions.\n');
    // The memories themselves are the user's: set aside for the switch coming back, never destroyed
    expect(existsSync(learned)).toBe(false);
    expect(await readFile(path.join(getStashedCompengDir(project), 'indentation-tabs.md'), 'utf-8')).toBe(
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
    for (const file of files) await writeFile(path.join(getCompengDir(project), file.name), file.text);
    await writeFile(
      getMemoryIndexPath(project),
      files.map((f) => `- [${f.name}](${f.name}) — hook\n`).join('')
    );
  };

  it('sets the memories aside instead of orphaning them, and restores them on the way back', async () => {
    await writeMemories(memory('tabs.md', 'Use tabs.\n'), memory('typecheck.md', 'Run typecheck.\n'));

    await removeProjectMemory(project);
    // Nothing points at the memory directory while the switch is off, so it must not be left there
    expect(existsSync(getCompengDir(project))).toBe(false);
    expect(existsSync(path.join(getStashedCompengDir(project), 'tabs.md'))).toBe(true);

    await applyProjectMemory(project);
    expect(await readFile(path.join(getCompengDir(project), 'tabs.md'), 'utf-8')).toBe('Use tabs.\n');
    expect(await readFile(path.join(getCompengDir(project), 'typecheck.md'), 'utf-8')).toBe('Run typecheck.\n');
    expect(existsSync(getStashedCompengDir(project))).toBe(false);

    const index = await readFile(getMemoryIndexPath(project), 'utf-8');
    expect(index).toContain('](tabs.md)');
    expect(index).toContain('](typecheck.md)');
  });

  it('merges the restored index with memories learned in the meantime, without duplicates', async () => {
    await writeMemories(memory('tabs.md', 'Use tabs.\n'));
    await removeProjectMemory(project);

    // While off, Claude Code learns elsewhere; the user may also have put something back by hand
    await mkdir(getCompengDir(project), { recursive: true });
    await writeFile(path.join(getCompengDir(project), 'naming.md'), 'Name things well.\n');
    await writeFile(getMemoryIndexPath(project), '- [naming.md](naming.md) — hook\n');

    await applyProjectMemory(project);

    const index = await readFile(getMemoryIndexPath(project), 'utf-8');
    expect(index.match(/\]\(naming\.md\)/g)).toHaveLength(1);
    expect(index).toContain('](tabs.md)');
    expect(existsSync(path.join(getCompengDir(project), 'naming.md'))).toBe(true);
  });

  it('keeps both files when a name exists on both sides, and names the restored one in the index', async () => {
    await writeMemories(memory('tabs.md', 'Stashed version.\n'));
    await removeProjectMemory(project);
    await mkdir(getCompengDir(project), { recursive: true });
    await writeFile(path.join(getCompengDir(project), 'tabs.md'), 'Newer version.\n');

    await applyProjectMemory(project);

    expect(await readFile(path.join(getCompengDir(project), 'tabs.md'), 'utf-8')).toBe('Newer version.\n');
    expect(await readFile(path.join(getCompengDir(project), 'tabs.restored.md'), 'utf-8')).toBe('Stashed version.\n');
    // A memory the index does not name is a memory nothing will ever load
    expect(await readFile(getMemoryIndexPath(project), 'utf-8')).toContain('](tabs.restored.md)');
  });

  it('points a restored memory at the file it ended up as, whatever the index here says', async () => {
    const live = getCompengDir(project);
    await applyProjectMemory(project);
    await writeFile(path.join(live, 'tabs.md'), 'Indent with tabs.\n');
    await writeFile(getMemoryIndexPath(project), '- [Indent with tabs](tabs.md) — how to indent\n');
    await removeProjectMemory(project);

    // While the switch was off another memory took that name, and the user wrote their own index by
    // hand with no line for it: nothing on this side names tabs.md, so nothing tells the merge that
    // the line coming back in is about a different memory than the file it links to
    await mkdir(live, { recursive: true });
    await writeFile(path.join(live, 'tabs.md'), 'Open files in tabs.\n');
    await writeFile(path.join(live, 'naming.md'), 'Name things well.\n');
    await writeFile(getMemoryIndexPath(project), '# My own notes\n\n- [Name things well](naming.md) — hook\n');

    await applyProjectMemory(project);

    const index = await readFile(getMemoryIndexPath(project), 'utf-8');
    // Every line in the index opens the memory it describes, and there is a line per memory
    const links = [...index.matchAll(/- \[([^\]]+)\]\(([^)]+)\)/g)].map(([, title, file]) => ({ title, file }));
    expect(links.map((link) => link.title).sort()).toEqual(['Indent with tabs', 'Name things well']);
    for (const link of links) {
      expect(await readFile(path.join(live, link.file), 'utf-8')).toBe(`${link.title}.\n`);
    }
    // Both memories of that name are still there, and so is what the user wrote around the lines
    expect(await readFile(path.join(live, 'tabs.md'), 'utf-8')).toBe('Open files in tabs.\n');
    expect(index.startsWith('# My own notes\n')).toBe(true);
  });

  it('numbers the restored copies, so a second collision of the same name keeps the first', async () => {
    const live = getCompengDir(project);
    const collide = async (text: string) => {
      await removeProjectMemory(project);
      await mkdir(live, { recursive: true });
      await writeFile(path.join(live, 'keep-local.md'), text);
      await applyProjectMemory(project);
    };

    await writeMemories(memory('keep-local.md', 'The first one.\n'));
    await collide('The second one.\n');
    // The same name collides again, and a rename replaces what is at the target without a word, so
    // the copy the first cycle restored is the one at risk
    await collide('The third one.\n');

    const kept = (await readdir(live)).filter((name) => name.startsWith('keep-local')).sort();
    expect(kept).toEqual(['keep-local.md', 'keep-local.restored-2.md', 'keep-local.restored.md']);
    // readdir decides which of the two incoming names is suffixed first, so what matters is that
    // all three texts are still there, each under a name of its own
    const texts = await Promise.all(kept.map((name) => readFile(path.join(live, name), 'utf-8')));
    expect(new Set(texts)).toEqual(new Set(['The first one.\n', 'The second one.\n', 'The third one.\n']));

    const index = await readFile(getMemoryIndexPath(project), 'utf-8');
    expect(index).toContain('](keep-local.restored.md)');
    expect(index).toContain('](keep-local.restored-2.md)');
  });

  it('moves everything the user put in the directory, not only the files it can read', async () => {
    await applyProjectMemory(project);
    const live = getCompengDir(project);
    await writeFile(path.join(live, 'tabs.md'), 'Use tabs.\n');
    await writeFile(path.join(live, 'scratch.txt'), 'A note in another format.\n');
    await mkdir(path.join(live, 'clippings'), { recursive: true });
    await writeFile(path.join(live, 'clippings', 'snippet.json'), '{"keep":true}\n');

    await removeProjectMemory(project);

    // Nothing here was ours to delete: a settings toggle never destroys what the user put there
    const stashed = getStashedCompengDir(project);
    expect(await readFile(path.join(stashed, 'scratch.txt'), 'utf-8')).toBe('A note in another format.\n');
    expect(await readFile(path.join(stashed, 'clippings', 'snippet.json'), 'utf-8')).toBe('{"keep":true}\n');
    expect(existsSync(live)).toBe(false);

    await applyProjectMemory(project);

    expect(await readFile(path.join(live, 'scratch.txt'), 'utf-8')).toBe('A note in another format.\n');
    expect(await readFile(path.join(live, 'clippings', 'snippet.json'), 'utf-8')).toBe('{"keep":true}\n');
    expect(existsSync(stashed)).toBe(false);
  });

  it('keeps what the user wrote into the index by hand', async () => {
    await applyProjectMemory(project);
    const authored = '# My notes\n\nRead these first.\n\n- [Tabs](tabs.md) — use tabs\n';
    await writeFile(getMemoryIndexPath(project), authored);
    await writeFile(path.join(getCompengDir(project), 'tabs.md'), 'Use tabs.\n');

    await removeProjectMemory(project);
    await applyProjectMemory(project);

    const index = await readFile(getMemoryIndexPath(project), 'utf-8');
    expect(index).toContain('# My notes');
    expect(index).toContain('Read these first.');
    expect(index.match(/\]\(tabs\.md\)/g)).toHaveLength(1);
  });

  it('leaves committed memories in place rather than moving tracked files', async () => {
    await writeMemories(memory('tabs.md', 'Use tabs.\n'));
    await execFileAsync('git', ['init', '-q'], { cwd: project });
    await execFileAsync('git', ['add', '-f', '.workbench/compeng'], { cwd: project });

    await removeProjectMemory(project);

    // The user committed these deliberately: a settings toggle does not delete tracked files
    expect(existsSync(path.join(getCompengDir(project), 'tabs.md'))).toBe(true);
    expect(existsSync(getStashedCompengDir(project))).toBe(false);
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
    await writeFile(path.join(getCompengDir(project), 'tabs.md'), 'Use tabs.\n');
    const stats = path.join(getCompengDir(project), 'index.json');
    await writeFile(stats, JSON.stringify({ memories: 1, sessionsScanned: 9, builtAt: '2026-10-18T00:00:00.000Z' }));

    await removeProjectMemory(project);
    expect(existsSync(path.join(getStashedCompengDir(project), 'index.json'))).toBe(true);

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
    expect(settings.autoMemoryDirectory).toBe(getCompengDir(project));
    expect(settings.autoMemoryDirectory).not.toBe(getCompengDir(worktree));
  });
});

// The repair reports how many settings files it rewrote: the checkout itself, plus any worktree
describe('repairProjectMemorySetting', () => {
  /** The switch lives in the project's own settings, which is where the repair reads it */
  const switchOn = () =>
    writeFile(path.join(project, '.workbench', 'settings.json'), JSON.stringify({ selfImprove: true }));

  const writeSettings = (content: string) =>
    mkdir(path.join(project, '.claude'), { recursive: true }).then(() => writeFile(localSettings(project), content));

  it('rewrites a value the other runtime spelled, after the shell runtime changed', async () => {
    await switchOn();
    await applyProjectMemory(project);
    expect((await readJson(localSettings(project))).autoMemoryDirectory).toBe(getCompengDir(project));

    // The user switched Settings > General > Shell to WSL and restarted
    runtime.wsl = true;

    expect(await repairProjectMemorySetting(project)).toBe(1);
    const settings = await readJson(localSettings(project));
    expect(settings.autoMemoryDirectory).toBe(runtime.toRuntimePath(getCompengDir(project)));
  });

  /**
   * A task's worktree is its own checkout with its own uncommitted settings file, pointed at the
   * project's store by `ensureWorktreeProjectMemory`, so a runtime switch leaves it spelled for the
   * other runtime exactly as it leaves the project.
   */
  it("rewrites the task worktrees' copies along with the project's", async () => {
    await switchOn();
    const worktree = path.join(project, '.workbench', 'worktrees', 'tasks', '001-task');
    await applyProjectMemory(project);
    await ensureWorktreeProjectMemory(worktree, project);
    expect((await readJson(localSettings(worktree))).autoMemoryDirectory).toBe(getCompengDir(project));

    runtime.wsl = true;

    // Both checkouts counted, and both now name the project's store as this runtime spells it
    expect(await repairProjectMemorySetting(project, [worktree])).toBe(2);
    const wanted = runtime.toRuntimePath(getCompengDir(project));
    expect((await readJson(localSettings(project))).autoMemoryDirectory).toBe(wanted);
    expect((await readJson(localSettings(worktree))).autoMemoryDirectory).toBe(wanted);
  });

  it('keeps the rest of the settings file when it rewrites the value', async () => {
    await switchOn();
    await writeSettings(
      JSON.stringify({ permissions: { allow: ['Bash'] }, autoMemoryDirectory: '/mnt/wsl/elsewhere/.workbench/compeng' }, null, 2)
    );

    expect(await repairProjectMemorySetting(project)).toBe(1);
    const settings = await readJson(localSettings(project));
    expect(settings.autoMemoryDirectory).toBe(getCompengDir(project));
    expect(settings.permissions).toEqual({ allow: ['Bash'] });
  });

  it('leaves a project that already holds this runtime\'s spelling untouched', async () => {
    await switchOn();
    // Hand-written formatting, so a rewrite would show even though the value is the same
    const authored = `{"autoMemoryDirectory":${JSON.stringify(getCompengDir(project))},"other":1}`;
    await writeSettings(authored);

    expect(await repairProjectMemorySetting(project)).toBe(0);
    expect(await readFile(localSettings(project), 'utf-8')).toBe(authored);
  });

  it('leaves a settings file it cannot parse alone rather than clobbering it', async () => {
    await switchOn();
    await writeSettings('{ not json');

    expect(await repairProjectMemorySetting(project)).toBe(0);
    expect(await readFile(localSettings(project), 'utf-8')).toBe('{ not json');
  });

  it('leaves a project whose switch is off alone, stale value and all', async () => {
    const stale = '/mnt/wsl/elsewhere/.workbench/compeng';
    await writeSettings(JSON.stringify({ autoMemoryDirectory: stale }, null, 2));

    expect(await repairProjectMemorySetting(project)).toBe(0);
    expect((await readJson(localSettings(project))).autoMemoryDirectory).toBe(stale);
  });

  it('writes no settings file for a project that never had the key', async () => {
    await switchOn();

    expect(await repairProjectMemorySetting(project)).toBe(0);
    expect(existsSync(localSettings(project))).toBe(false);
  });
});
