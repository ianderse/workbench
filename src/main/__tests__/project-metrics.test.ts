import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { getProjectCostMetrics } from '../project-metrics';
import type { Project } from '../../shared/types';

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
