import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { countMemories, listMemories, writeMemories, MAX_MEMORIES, type MemoryDraft } from '../memory-writer';
import { getCompengDir, getMemoryIndexPath } from '../paths';

let tmp: string;
let project: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-memory-writer-'));
  project = path.join(tmp, 'project');
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('writeMemories', () => {
  const draft = (name: string, overrides: Partial<MemoryDraft> = {}): MemoryDraft => ({
    name,
    title: `Title ${name}`,
    description: `Rule ${name}`,
    type: 'feedback',
    body: `Do ${name}.\n\n**Why:** stated by the user.\n\n**How to apply:** always.`,
    ...overrides,
  });

  it("writes Claude Code's own memory shape and one index line each", async () => {
    await writeMemories(project, [draft('use-tabs')]);

    const file = await readFile(path.join(getCompengDir(project), 'use-tabs.md'), 'utf-8');
    expect(file).toContain('name: use-tabs');
    expect(file).toContain('  node_type: memory');
    expect(file).toContain('  type: feedback');
    expect(file).toMatch(/ {2}modified: \d{4}-\d{2}-\d{2}T/);
    expect(file).toContain('**Why:**');

    expect(await readFile(getMemoryIndexPath(project), 'utf-8')).toBe(
      '- [Title use-tabs](use-tabs.md) — Rule use-tabs\n'
    );
  });

  it('never overwrites a memory already on disk, since it may have been edited', async () => {
    await writeMemories(project, [draft('use-tabs')]);
    await writeFile(path.join(getCompengDir(project), 'use-tabs.md'), 'edited by hand\n');

    await writeMemories(project, [draft('use-tabs'), draft('run-typecheck')]);

    expect(await readFile(path.join(getCompengDir(project), 'use-tabs.md'), 'utf-8')).toBe('edited by hand\n');
    const index = await readFile(getMemoryIndexPath(project), 'utf-8');
    expect(index.match(/\]\(use-tabs\.md\)/g)).toHaveLength(1);
    expect(index).toContain('](run-typecheck.md)');
  });

  it('keeps the text the user wrote into the index themselves', async () => {
    await writeMemories(project, [draft('use-tabs')]);
    const authored = '# Project memory\n\nThe ones that matter most are first.\n\n- [Title use-tabs](use-tabs.md) — Rule use-tabs\n';
    await writeFile(getMemoryIndexPath(project), authored);

    await writeMemories(project, [draft('run-typecheck')]);

    // MEMORY.md is the user's index file; rebuilding it from the lines we can parse loses the rest
    const index = await readFile(getMemoryIndexPath(project), 'utf-8');
    expect(index).toContain('# Project memory');
    expect(index).toContain('The ones that matter most are first.');
    expect(index.match(/\]\(use-tabs\.md\)/g)).toHaveLength(1);
    expect(index).toContain('](run-typecheck.md)');
  });

  it('lists what the project already remembers, so a rebuild is told not to write it again', async () => {
    await writeMemories(project, [draft('use-tabs')]);

    expect(await listMemories(project)).toEqual(['[Title use-tabs](use-tabs.md) — Rule use-tabs']);
  });

  it('slugifies a name and stops at the cap, so the index stays inside its read limit', async () => {
    const written = await writeMemories(project, [draft('Use Tabs, Not Spaces!')]);
    expect(written).toEqual(['use-tabs-not-spaces']);

    await writeMemories(
      project,
      Array.from({ length: MAX_MEMORIES + 10 }, (_, i) => draft(`rule-${i}`))
    );
    expect(await countMemories(project)).toBe(MAX_MEMORIES);
  });
});
