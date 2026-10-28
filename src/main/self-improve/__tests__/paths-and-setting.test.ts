import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { getCompengDir, getMemoryIndexImportPath, getMemoryIndexPath } from '../paths';
import { isSelfImproveEnabled, isSelfImproveEnabledForPath } from '../setting';
import { SELF_IMPROVE_NUDGE } from '../nudge';

let project: string;

beforeEach(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), 'wb-selfimprove-paths-'));
  // The switch only exists for an initialized project, which is what `.workbench` marks
  await mkdir(path.join(project, '.workbench'), { recursive: true });
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe('paths', () => {
  it('keeps the memory folder out of .workbench/knowledge', () => {
    // .workbench/knowledge existing is what turns the project's Use Graphify switch on
    // (graphify-paths.ts), so this feature must never write inside it
    expect(getCompengDir(project)).toBe(path.join(project, '.workbench', 'compeng'));
    expect(getCompengDir(project)).not.toContain(path.join('.workbench', 'knowledge'));
    expect(getMemoryIndexPath(project)).toBe(path.join(getCompengDir(project), 'MEMORY.md'));
  });

  it('imports the index with a path relative to the project root, forward slashes', () => {
    expect(getMemoryIndexImportPath()).toBe('.workbench/compeng/MEMORY.md');
  });
});

describe('isSelfImproveEnabledForPath', () => {
  const write = async (settings: unknown) => {
    await mkdir(path.join(project, '.workbench'), { recursive: true });
    await writeFile(path.join(project, '.workbench', 'settings.json'), JSON.stringify(settings));
  };

  it('is false without a settings file, and false for an undefined path', async () => {
    expect(await isSelfImproveEnabledForPath(project)).toBe(false);
    expect(await isSelfImproveEnabledForPath(undefined)).toBe(false);
  });

  it('is true only when the switch is explicitly on', async () => {
    await write({ selfImprove: true });
    expect(await isSelfImproveEnabledForPath(project)).toBe(true);

    await write({ selfImprove: false });
    expect(await isSelfImproveEnabledForPath(project)).toBe(false);

    await write({ useClaudeMd: true });
    expect(await isSelfImproveEnabledForPath(project)).toBe(false);
  });

  it('is false for unreadable settings rather than throwing', async () => {
    await mkdir(path.join(project, '.workbench'), { recursive: true });
    await writeFile(path.join(project, '.workbench', 'settings.json'), '{ not json');
    expect(await isSelfImproveEnabledForPath(project)).toBe(false);
  });
});

describe('isSelfImproveEnabled', () => {
  it('defaults to off', () => {
    expect(isSelfImproveEnabled(undefined)).toBe(false);
    expect(isSelfImproveEnabled({})).toBe(false);
    expect(isSelfImproveEnabled({ selfImprove: false })).toBe(false);
    expect(isSelfImproveEnabled({ selfImprove: true })).toBe(true);
  });
});

describe('the nudge', () => {
  it('states when to save, the bar, and what to do with a contradiction', () => {
    expect(SELF_IMPROVE_NUDGE).toContain('type: feedback');
    expect(SELF_IMPROVE_NUDGE).toMatch(/newer one wins/i);
    expect(SELF_IMPROVE_NUDGE).toMatch(/CLAUDE\.md already make clear/i);
    expect(SELF_IMPROVE_NUDGE).toMatch(/never record secrets/i);
  });

  it('says how to tell a lasting rule from a one-off instruction', () => {
    for (const cue of ['always', 'never', 'from now on', 'by default', 'I prefer', 'we use', 'as I said']) {
      expect(SELF_IMPROVE_NUDGE).toContain(cue);
    }
    expect(SELF_IMPROVE_NUDGE).toMatch(/strongest signal/);
    expect(SELF_IMPROVE_NUDGE).toMatch(/would make the same mistake/);
    expect(SELF_IMPROVE_NUDGE).toMatch(/just this once/);
  });

  it("has no quotes, so it survives an agent window's shell-quoted flag (single quotes in POSIX shells, double in cmd)", () => {
    expect(SELF_IMPROVE_NUDGE).not.toContain("'");
    expect(SELF_IMPROVE_NUDGE).not.toContain('"');
  });
});
