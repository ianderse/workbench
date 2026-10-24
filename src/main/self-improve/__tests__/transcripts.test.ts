import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { belongsToProject, findProjectTranscripts, readUserTurns } from '../transcripts';

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: () => ({ getProfileConfigDirs: () => [] }),
}));

let tmp: string;
let project: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-transcripts-'));
  project = path.join(tmp, 'project');
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe('belongsToProject', () => {
  it('accepts the project itself and anything inside it, worktrees included', () => {
    expect(belongsToProject('/repo', '/repo')).toBe(true);
    expect(belongsToProject('/repo/src', '/repo')).toBe(true);
    expect(belongsToProject('/repo/.workbench/worktrees/tasks/001', '/repo')).toBe(true);
  });

  it('rejects a sibling whose name only starts the same', () => {
    // The whole point of matching on path components: my-repo-old is a different project
    expect(belongsToProject('/work/my-repo-old', '/work/my-repo')).toBe(false);
    expect(belongsToProject('/work/other', '/work/my-repo')).toBe(false);
  });

  it('rejects a session started above the project', () => {
    // A session in the parent may have been about a sibling project; a preference learned from
    // one project and written into another is worse than one missed
    expect(belongsToProject('/work', '/work/my-repo')).toBe(false);
    expect(belongsToProject('/', '/work/my-repo')).toBe(false);
  });
});

describe('findProjectTranscripts', () => {
  const session = async (configDir: string, encoded: string, name: string, lines: unknown[]) => {
    const dir = path.join(configDir, 'projects', encoded);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    return file;
  };

  it('attributes a session by its recorded cwd, not by the folder name', async () => {
    const configDir = path.join(tmp, 'config');
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const mine = await session(configDir, 'anything-at-all', 'a.jsonl', [
      { type: 'user', cwd: project, message: { role: 'user', content: 'hello' } },
    ]);
    // A folder named the way Claude Code encodes this very project, holding someone else's session.
    // Separators and the Windows drive colon are replaced, since this has to be one legal segment.
    const temptingName = project.replace(/[\\/:]/g, '-');
    await session(configDir, temptingName, 'b.jsonl', [
      { type: 'user', cwd: path.join(tmp, 'elsewhere'), message: { role: 'user', content: 'hi' } },
    ]);

    const found = await findProjectTranscripts(project);
    expect(found.map((t) => t.file)).toEqual([mine]);
  });

  it('drops a transcript with no recorded cwd rather than guessing', async () => {
    const configDir = path.join(tmp, 'config');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    await session(configDir, 'x', 'a.jsonl', [{ type: 'user', message: { role: 'user', content: 'hello' } }]);

    expect(await findProjectTranscripts(project)).toEqual([]);
  });

  it('excludes the session that asked, and caps how many it returns', async () => {
    const configDir = path.join(tmp, 'config');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    for (const name of ['one', 'two', 'three']) {
      await session(configDir, 'x', `${name}.jsonl`, [
        { type: 'user', cwd: project, message: { role: 'user', content: name } },
      ]);
    }

    expect(await findProjectTranscripts(project, { excludeSessionId: 'two' })).toHaveLength(2);
    expect(await findProjectTranscripts(project, { maxSessions: 1 })).toHaveLength(1);
  });
});

describe('readUserTurns', () => {
  it('keeps what the person typed and leaves out tool results and injections', async () => {
    const file = path.join(tmp, 'session.jsonl');
    await writeFile(
      file,
      [
        { type: 'user', cwd: project, message: { role: 'user', content: 'always use tabs' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
        { type: 'user', isMeta: true, message: { role: 'user', content: 'injected' } },
        { type: 'user', message: { role: 'user', content: '<system-reminder>noise</system-reminder>' } },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'never use spaces' }] } },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')
    );

    expect(await readUserTurns(file, 10_000)).toEqual(['always use tabs', 'never use spaces']);
  });

  it("leaves out Workbench's own phase prompts, which are the app talking and not the user", async () => {
    const file = path.join(tmp, 'task-run.jsonl');
    await writeFile(
      file,
      [
        // The turns a task run's phases send (claude-code/task-runner.ts, buildInput)
        { type: 'user', message: { role: 'user', content: 'Continue the task from where you left off. Check `git status` and `git log` to see what is already done, then finish the work.' } },
        { type: 'user', message: { role: 'user', content: 'The plan is approved. Implement it now, verify it with the project\'s tests, and commit the result.' } },
        { type: 'user', message: { role: 'user', content: 'Before handing this off, validate the work:\n1. Run the tests. Fix failures your change caused.' } },
        { type: 'user', message: { role: 'user', content: 'The reviewer requested changes:\n\n<feedback>\nUse tabs\n</feedback>' } },
        { type: 'user', message: { role: 'user', content: 'always run the type checker before committing' } },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')
    );

    // Learning a "preference" from these would record Workbench's own instructions as the user's
    expect(await readUserTurns(file, 10_000)).toEqual(['always run the type checker before committing']);
  });

  it("leaves out Workbench's notices and peer messages written into the session", async () => {
    const file = path.join(tmp, 'messages.jsonl');
    await writeFile(
      file,
      [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Workbench] Task 002 was merged into main. Merge main into your branch now.' }, { type: 'text', text: '[Workbench message wbm-1a2b]' }] } },
        { type: 'user', message: { role: 'user', content: '[Message from task 003-api "API" (session wb-x-003)]\nAlways use snake_case in the schema' } },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Prefer small commits' }, { type: 'text', text: '[Workbench message wbm-ff00]' }] } },
        { type: 'user', message: { role: 'user', content: 'prefer pnpm over npm' } },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')
    );

    expect(await readUserTurns(file, 10_000)).toEqual(['prefer pnpm over npm']);
  });

  it('stops at the character budget', async () => {
    const file = path.join(tmp, 'long.jsonl');
    const turn = 'x'.repeat(100);
    await writeFile(
      file,
      Array.from({ length: 10 }, () =>
        JSON.stringify({ type: 'user', message: { role: 'user', content: turn } })
      ).join('\n')
    );

    const turns = await readUserTurns(file, 250);
    expect(turns.join('').length).toBeLessThanOrEqual(250);
    expect(turns.length).toBeLessThan(10);
  });
});
