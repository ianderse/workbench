/**
 * The memory index build, which is re-runnable by hand over sessions it has already read. What the
 * project remembers has to reach the prompt, or a second run writes the same memories again.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const configDirRef = vi.hoisted(() => ({ path: '' }));
vi.mock('../../claude-profile/profile-config-dirs', () => ({
  claudeConfigDirs: () => [configDirRef.path],
}));

const runClaudeText = vi.hoisted(() => vi.fn());
vi.mock('../../claude-code/run-text', () => ({ runClaudeText }));

import { buildMemoryIndex } from '../backfill';
import { getMemoryIndexPath } from '../paths';

let tmp: string;
let project: string;

/** One memory the model keeps proposing, run after run */
const tabs = {
  name: 'use-tabs',
  title: 'Use tabs',
  description: 'Indent with tabs, never spaces',
  type: 'feedback',
  body: 'Indent with tabs.\n\n**Why:** stated by the user.\n\n**How to apply:** always.',
};

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-backfill-'));
  project = path.join(tmp, 'project');
  await mkdir(project, { recursive: true });
  configDirRef.path = path.join(tmp, 'claude');

  const dir = path.join(configDirRef.path, 'projects', 'anything');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'a.jsonl'),
    `${JSON.stringify({ type: 'user', cwd: project, message: { role: 'user', content: 'always indent with tabs' } })}\n`
  );

  runClaudeText.mockReset();
  runClaudeText.mockResolvedValue({ structured: { memories: [tabs] } });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('building the memory index twice', () => {
  it('tells the second run what the project already remembers', async () => {
    await buildMemoryIndex(project);
    await buildMemoryIndex(project);

    const [first, second] = runClaudeText.mock.calls.map(([options]) => options.prompt as string);
    // The first build has nothing to leave out; the second must not be asked to write it again
    expect(first).not.toContain('already exist');
    expect(second).toContain('These memories already exist, so do not restate them:');
    expect(second).toContain('Indent with tabs, never spaces');
  });

  it('writes no duplicate of a memory it already has', async () => {
    await buildMemoryIndex(project);
    const afterFirst = await readFile(getMemoryIndexPath(project), 'utf-8');

    await buildMemoryIndex(project);

    const index = await readFile(getMemoryIndexPath(project), 'utf-8');
    expect(index).toBe(afterFirst);
    expect(index.match(/\]\(use-tabs\.md\)/g)).toHaveLength(1);
  });
});
