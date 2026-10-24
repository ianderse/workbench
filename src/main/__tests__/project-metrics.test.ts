import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { getProjectCostMetrics, warmProjectMetrics } from '../project-metrics';
import type { Project } from '../../shared/types';

// No profile manager runs in tests; the config dirs recorded with a session are enough
vi.mock('../claude-profile-manager', () => ({ getClaudeProfileManager: () => ({ getProfileConfigDirs: () => [] }) }));

const project = (id: string, dir: string): Project => ({
  id,
  name: id,
  path: dir,
  autoBuildPath: '.workbench',
  settings: {} as Project['settings'],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('getProjectCostMetrics', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'metrics-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sums the run costs of every task in initialized projects and skips the others', async () => {
    const initialized = path.join(root, 'a');
    const specs = path.join(initialized, '.workbench', 'tasks');
    mkdirSync(path.join(specs, '001-one'), { recursive: true });
    mkdirSync(path.join(specs, '002-two'), { recursive: true });
    mkdirSync(path.join(specs, '003-never-ran'), { recursive: true });
    writeFileSync(path.join(specs, '001-one', 'claude_run.json'), JSON.stringify({ totalCostUsd: 0.25 }));
    writeFileSync(path.join(specs, '002-two', 'claude_run.json'), JSON.stringify({ totalCostUsd: 1.5 }));

    const empty = path.join(root, 'b');
    mkdirSync(path.join(empty, '.workbench'), { recursive: true });

    const notInitialized = path.join(root, 'c');
    mkdirSync(notInitialized, { recursive: true });

    const metrics = await getProjectCostMetrics([
      project('a', initialized),
      project('b', empty),
      project('c', notInitialized),
    ]);

    expect(metrics).toEqual([
      { projectId: 'a', name: 'a', path: initialized, taskCount: 3, totalCostUsd: 1.75, daily: [] },
      { projectId: 'b', name: 'b', path: empty, taskCount: 0, totalCostUsd: 0, daily: [] },
    ]);
  });

  it('counts what the runs a task was started over from cost', async () => {
    const dir = path.join(root, 'a');
    const specDir = path.join(dir, '.workbench', 'tasks', '001-one');
    mkdirSync(path.join(specDir, 'previous_runs', '001'), { recursive: true });
    mkdirSync(path.join(specDir, 'previous_runs', '002'), { recursive: true });
    writeFileSync(path.join(specDir, 'claude_run.json'), JSON.stringify({ totalCostUsd: 0.25 }));
    writeFileSync(path.join(specDir, 'previous_runs', '001', 'claude_run.json'), JSON.stringify({ totalCostUsd: 1 }));
    writeFileSync(path.join(specDir, 'previous_runs', '002', 'claude_run.json'), JSON.stringify({ totalCostUsd: 0.5 }));

    const [metrics] = await getProjectCostMetrics([project('a', dir)]);

    expect(metrics.totalCostUsd).toBe(1.75);
    expect(metrics.taskCount).toBe(1);
  });

  it('counts an archived run of a task whose current run was reset', async () => {
    const dir = path.join(root, 'a');
    const specDir = path.join(dir, '.workbench', 'tasks', '001-one');
    mkdirSync(path.join(specDir, 'previous_runs', '001'), { recursive: true });
    writeFileSync(path.join(specDir, 'previous_runs', '001', 'claude_run.json'), JSON.stringify({ totalCostUsd: 2 }));

    const [metrics] = await getProjectCostMetrics([project('a', dir)]);

    expect(metrics.totalCostUsd).toBe(2);
  });
});

describe('spending per day', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'metrics-daily-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A run whose steps started on the given local days */
  const run = (updatedAt: string, phases: Array<[string, number]>) =>
    JSON.stringify({
      version: 1,
      phases: phases.map(([startedAt, costUsd]) => ({ name: 'implement', startedAt, costUsd })),
      subagents: [],
      totalCostUsd: phases.reduce((sum, [, costUsd]) => sum + costUsd, 0),
      updatedAt,
    });

  /** Timestamp of a local hour on a local day, the way a run file stores it */
  const at = (day: string, hour: number): string => {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(year, month - 1, date, hour).toISOString();
  };

  it('books every step on the day it started, across tasks and archived runs', async () => {
    const dir = path.join(root, 'a');
    const specs = path.join(dir, '.workbench', 'tasks');
    mkdirSync(path.join(specs, '001-one', 'previous_runs', '001'), { recursive: true });
    mkdirSync(path.join(specs, '002-two'), { recursive: true });
    writeFileSync(path.join(specs, '001-one', 'claude_run.json'), run(at('2026-10-20', 12), [
      [at('2026-10-19', 23), 0.5],
      [at('2026-10-20', 1), 0.25],
    ]));
    writeFileSync(path.join(specs, '001-one', 'previous_runs', '001', 'claude_run.json'), run(at('2026-10-18', 9), [
      [at('2026-10-18', 9), 1],
    ]));
    writeFileSync(path.join(specs, '002-two', 'claude_run.json'), run(at('2026-10-20', 15), [
      [at('2026-10-20', 15), 2],
    ]));

    const [metrics] = await getProjectCostMetrics([project('a', dir)]);

    expect(metrics.daily).toEqual([
      { date: '2026-10-18', costUsd: 1 },
      { date: '2026-10-19', costUsd: 0.5 },
      { date: '2026-10-20', costUsd: 2.25 },
    ]);
    expect(metrics.totalCostUsd).toBe(3.75);
  });

  it('books what a run cost beyond its steps on the day it was last written', async () => {
    const dir = path.join(root, 'a');
    const specDir = path.join(dir, '.workbench', 'tasks', '001-one');
    mkdirSync(specDir, { recursive: true });
    // An older run: a total, but no cost on its steps
    writeFileSync(path.join(specDir, 'claude_run.json'), JSON.stringify({
      phases: [{ name: 'implement', startedAt: at('2026-10-20', 10) }],
      totalCostUsd: 0.75,
      updatedAt: at('2026-10-20', 11),
    }));

    const [metrics] = await getProjectCostMetrics([project('a', dir)]);

    expect(metrics.daily).toEqual([{ date: '2026-10-20', costUsd: 0.75 }]);
  });

  it('leaves out a run with no usable timestamps', async () => {
    const dir = path.join(root, 'a');
    const specDir = path.join(dir, '.workbench', 'tasks', '001-one');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(path.join(specDir, 'claude_run.json'), JSON.stringify({ totalCostUsd: 0.5 }));

    const [metrics] = await getProjectCostMetrics([project('a', dir)]);

    expect(metrics.daily).toEqual([]);
    expect(metrics.totalCostUsd).toBe(0.5);
  });
});

describe('agent window spending', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'metrics-windows-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Timestamp of a local hour on a local day, the way a transcript stores it */
  const at = (day: string, hour: number): string => {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(year, month - 1, date, hour).toISOString();
  };

  /** An assistant record whose tokens price to `costUsd` ($25 per million output on Claude Opus 5) */
  const turn = (day: string, hour: number, costUsd: number) =>
    JSON.stringify({
      type: 'assistant',
      requestId: `req-${day}-${hour}`,
      timestamp: at(day, hour),
      message: { model: 'claude-opus-5', usage: { output_tokens: costUsd * 40_000 } },
    });

  /** The sessions a project's agent windows started, and the transcript of one of them */
  const givenWindowSession = (dir: string, sessionId: string, day: string, costUsd: number): string => {
    const configDir = path.join(root, 'config');
    const transcripts = path.join(configDir, 'projects', '-project');
    mkdirSync(transcripts, { recursive: true });
    const [year, month, date] = day.split('-').map(Number);
    writeFileSync(
      path.join(transcripts, `${sessionId}.jsonl`),
      [
        turn(day, 10, costUsd),
        JSON.stringify({
          type: 'cost-state',
          startTime: new Date(year, month - 1, date, 9).getTime(),
          totalCostUSD: costUsd,
        }),
      ].join('\n')
    );

    mkdirSync(path.join(dir, '.workbench'), { recursive: true });
    writeFileSync(
      path.join(dir, '.workbench', 'agent-sessions.json'),
      JSON.stringify({ version: 1, sessions: [{ sessionId, configDir, startedAt: at(day, 9) }] })
    );
    return path.join(transcripts, `${sessionId}.jsonl`);
  };

  /** What the project's store says about its window sessions */
  const storedSessions = (dir: string) =>
    JSON.parse(readFileSync(path.join(dir, '.workbench', 'agent-sessions.json'), 'utf-8')).sessions;

  it('counts what the agent windows spent, on the days they spent it', async () => {
    const dir = path.join(root, 'a');
    const specDir = path.join(dir, '.workbench', 'tasks', '001-one');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      path.join(specDir, 'claude_run.json'),
      JSON.stringify({
        phases: [{ name: 'implement', startedAt: at('2026-10-20', 12), costUsd: 1 }],
        totalCostUsd: 1,
        updatedAt: at('2026-10-20', 13),
      })
    );
    givenWindowSession(dir, 'window-session', '2026-10-20', 0.5);

    const [metrics] = await getProjectCostMetrics([project('a', dir)]);

    expect(metrics.totalCostUsd).toBe(1.5);
    expect(metrics.daily).toEqual([{ date: '2026-10-20', costUsd: 1.5 }]);
  });

  it('counts a window session in a project with no tasks at all', async () => {
    const dir = path.join(root, 'b');
    givenWindowSession(dir, 'window-session', '2026-10-21', 0.25);

    const [metrics] = await getProjectCostMetrics([project('b', dir)]);

    expect(metrics.taskCount).toBe(0);
    expect(metrics.totalCostUsd).toBe(0.25);
    expect(metrics.daily).toEqual([{ date: '2026-10-21', costUsd: 0.25 }]);
  });

  it('keeps what a transcript cost, and counts it again after the transcript is gone', async () => {
    const dir = path.join(root, 'c');
    const transcript = givenWindowSession(dir, 'window-session', '2026-10-20', 0.5);

    await getProjectCostMetrics([project('c', dir)]);

    // The reading is kept with the session, so an unchanged transcript is not read again. The turns
    // and the totals Claude Code reported are kept with it too, because the project is reconciled
    // from those and a cached session has to take part in that like a freshly read one.
    expect(storedSessions(dir)[0].spent).toEqual({
      totalCostUsd: 0.5,
      days: { '2026-10-20': 0.5 },
      transcript,
      size: expect.any(Number),
      modifiedMs: expect.any(Number),
      estimate: { days: { '2026-10-20': 0.5 }, total: 0.5, undated: 0 },
      lastDay: '2026-10-20',
      runs: { [`run:${new Date(2026, 9, 20, 9).getTime()}`]: 0.5 },
    });

    unlinkSync(transcript);
    const [metrics] = await getProjectCostMetrics([project('c', dir)]);

    expect(metrics.totalCostUsd).toBe(0.5);
    expect(metrics.daily).toEqual([{ date: '2026-10-20', costUsd: 0.5 }]);
  });

  describe('a process that wrote its total to more than one transcript', () => {
    /** Two conversations one Claude Code process worked on, each carrying its running total */
    const givenSharedProcess = (dir: string, first: number, second: number): string[] => {
      const configDir = path.join(root, 'config');
      const transcripts = path.join(configDir, 'projects', '-project');
      mkdirSync(transcripts, { recursive: true });
      const startTime = new Date(2026, 9, 20, 9).getTime();
      const files = [
        [path.join(transcripts, 'first.jsonl'), turn('2026-10-20', 10, 20), first],
        [path.join(transcripts, 'second.jsonl'), turn('2026-10-21', 10, 20), second],
      ] as const;
      for (const [file, priced, totalCostUSD] of files) {
        writeFileSync(file, [priced, JSON.stringify({ type: 'cost-state', startTime, totalCostUSD })].join('\n'));
      }

      mkdirSync(path.join(dir, '.workbench'), { recursive: true });
      writeFileSync(
        path.join(dir, '.workbench', 'agent-sessions.json'),
        JSON.stringify({
          version: 1,
          sessions: [
            { sessionId: 'first', configDir, startedAt: at('2026-10-20', 9) },
            { sessionId: 'second', configDir, startedAt: at('2026-10-21', 9) },
          ],
        })
      );
      return files.map(([file]) => file);
    };

    it('counts its total once for the project, not once per transcript', async () => {
      const dir = path.join(root, 'shared');
      givenSharedProcess(dir, 103.9, 86.37);

      const [metrics] = await getProjectCostMetrics([project('shared', dir)]);

      // The process spent $103.90 in all; each conversation reports a figure of that same total
      expect(metrics.totalCostUsd).toBeCloseTo(103.9, 6);
      expect(metrics.daily).toEqual([
        { date: '2026-10-20', costUsd: 51.95 },
        { date: '2026-10-21', costUsd: 51.95 },
      ]);
    });

    it('still counts it once when one transcript is read again and the other is not', async () => {
      const dir = path.join(root, 'shared-again');
      const [, second] = givenSharedProcess(dir, 103.9, 86.37);

      // Read once, so both readings are kept with their sessions
      await getProjectCostMetrics([project('shared-again', dir)]);
      expect((await getProjectCostMetrics([project('shared-again', dir)]))[0].totalCostUsd).toBeCloseTo(103.9, 6);

      // The process went on spending, and wrote its new total to the second conversation only
      writeFileSync(
        second,
        `${readFileSync(second, 'utf-8')}\n` +
          JSON.stringify({ type: 'cost-state', startTime: new Date(2026, 9, 20, 9).getTime(), totalCostUSD: 110 })
      );
      const [metrics] = await getProjectCostMetrics([project('shared-again', dir)]);

      expect(metrics.totalCostUsd).toBeCloseTo(110, 6);
    });

    it('reads a transcript again when the reading kept with it predates the process totals', async () => {
      const dir = path.join(root, 'older-store');
      const [first] = givenSharedProcess(dir, 103.9, 86.37);
      const stored = JSON.parse(readFileSync(path.join(dir, '.workbench', 'agent-sessions.json'), 'utf-8'));
      const { size, mtimeMs } = statSync(first);
      // What an older version kept: the scaled total and days, with nothing to recognize the
      // process by, so adding it to the other transcript's total would count the same dollars twice
      stored.sessions[0].spent = {
        totalCostUsd: 103.9,
        days: { '2026-10-20': 103.9 },
        transcript: first,
        size,
        modifiedMs: mtimeMs,
      };
      writeFileSync(path.join(dir, '.workbench', 'agent-sessions.json'), JSON.stringify(stored));

      const [metrics] = await getProjectCostMetrics([project('older-store', dir)]);

      expect(metrics.totalCostUsd).toBeCloseTo(103.9, 6);
      expect(storedSessions(dir)[0].spent.runs).toEqual({ [`run:${new Date(2026, 9, 20, 9).getTime()}`]: 103.9 });
    });
  });

  describe('every Claude Code session of the project', () => {
    /** A transcript of a session that ran in `cwd`, in the folder Claude Code names after it */
    const givenSession = (sessionId: string, cwd: string, day: string, costUsd: number): string => {
      const dir = path.join(root, 'config', 'projects', cwd.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '').replace(/[/.]/g, '-'));
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sessionId}.jsonl`);
      writeFileSync(
        file,
        [JSON.stringify({ type: 'user', cwd, sessionId, timestamp: at(day, 9) }), turn(day, 10, costUsd)].join('\n')
      );
      return file;
    };

    beforeEach(() => {
      // The sessions of a project with no recorded windows are still found under this account
      process.env.CLAUDE_CONFIG_DIR = path.join(root, 'config');
    });

    afterEach(() => {
      delete process.env.CLAUDE_CONFIG_DIR;
    });

    it('counts a session that ran in the project although no window recorded it', async () => {
      const dir = path.join(root, 'found');
      mkdirSync(path.join(dir, '.workbench'), { recursive: true });
      givenSession('own-terminal', dir, '2026-10-20', 0.5);
      givenSession('in-a-subdirectory', path.join(dir, 'src'), '2026-10-21', 0.25);

      const [metrics] = await getProjectCostMetrics([project('found', dir)]);

      expect(metrics.totalCostUsd).toBeCloseTo(0.75, 6);
      expect(metrics.daily).toEqual([
        { date: '2026-10-20', costUsd: 0.5 },
        { date: '2026-10-21', costUsd: 0.25 },
      ]);
      // Kept with the project, so the next refresh only reads the transcripts that changed
      expect(storedSessions(dir).map((s: { sessionId: string }) => s.sessionId).sort()).toEqual([
        'in-a-subdirectory',
        'own-terminal',
      ]);
      expect(storedSessions(dir).every((s: { spent?: unknown }) => !!s.spent)).toBe(true);
    });

    it('leaves the sessions of tasks and their worktrees to the task figures', async () => {
      const dir = path.join(root, 'tasks');
      const specDir = path.join(dir, '.workbench', 'tasks', '001-one');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(
        path.join(specDir, 'claude_run.json'),
        JSON.stringify({
          sessionId: 'task-session',
          phases: [{ name: 'implement', sessionId: 'earlier-task-session', startedAt: at('2026-10-20', 12), costUsd: 1 }],
          totalCostUsd: 1,
          updatedAt: at('2026-10-20', 13),
        })
      );
      // The task's own session (a task without a worktree runs in the project directory)
      givenSession('task-session', dir, '2026-10-20', 5);
      givenSession('earlier-task-session', dir, '2026-10-20', 5);
      // A task run in its worktree
      givenSession('worktree-session', path.join(dir, '.workbench', 'worktrees', 'tasks', '001-one'), '2026-10-20', 5);
      // And a session that really is the project's own
      givenSession('insights', dir, '2026-10-20', 0.5);

      const [metrics] = await getProjectCostMetrics([project('tasks', dir)]);

      expect(metrics.totalCostUsd).toBeCloseTo(1.5, 6);
    });

    it('reads a project\'s sessions once in the background when it is opened', async () => {
      const dir = path.join(root, 'warm');
      mkdirSync(path.join(dir, '.workbench'), { recursive: true });
      givenSession('own-terminal', dir, '2026-10-20', 0.5);
      const onWarm = vi.fn();

      warmProjectMetrics([project('warm', dir)], onWarm);
      for (let waited = 0; waited < 3000 && onWarm.mock.calls.length === 0; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(onWarm).toHaveBeenCalledTimes(1);
      expect(storedSessions(dir)[0].spent.totalCostUsd).toBeCloseTo(0.5, 6);

      // Already read: opening the project again does no work
      warmProjectMetrics([project('warm', dir)], onWarm);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(onWarm).toHaveBeenCalledTimes(1);
    });

    it('counts a found session once, not again as a recorded one', async () => {
      const dir = path.join(root, 'once');
      mkdirSync(path.join(dir, '.workbench'), { recursive: true });
      givenSession('window-session', dir, '2026-10-20', 0.5);
      writeFileSync(
        path.join(dir, '.workbench', 'agent-sessions.json'),
        JSON.stringify({
          version: 1,
          sessions: [{ sessionId: 'window-session', configDir: path.join(root, 'config'), cwd: dir, startedAt: at('2026-10-20', 9) }],
        })
      );

      const [metrics] = await getProjectCostMetrics([project('once', dir)]);

      expect(metrics.totalCostUsd).toBeCloseTo(0.5, 6);
      expect(storedSessions(dir)).toHaveLength(1);
    });
  });

  it('reads a transcript again once it has grown', async () => {
    const dir = path.join(root, 'd');
    const transcript = givenWindowSession(dir, 'window-session', '2026-10-20', 0.5);

    await getProjectCostMetrics([project('d', dir)]);

    writeFileSync(
      transcript,
      `${readFileSync(transcript, 'utf-8')}\n${turn('2026-10-21', 10, 1.5)}` +
        `\n${JSON.stringify({ type: 'cost-state', startTime: new Date(2026, 9, 20, 9).getTime(), totalCostUSD: 2 })}`
    );
    const [metrics] = await getProjectCostMetrics([project('d', dir)]);

    expect(metrics.totalCostUsd).toBe(2);
    expect(metrics.daily).toEqual([
      { date: '2026-10-20', costUsd: 0.5 },
      { date: '2026-10-21', costUsd: 1.5 },
    ]);
  });
});
