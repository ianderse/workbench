/**
 * Starting a task over throws its run away. What it did is kept under previous_runs/ so the
 * task dialog can still show it, and the spec dir reset must leave that folder alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./project-store', () => ({
  projectStore: { invalidateTasksCache: vi.fn() }
}));

import { archiveCurrentRun, listPreviousRuns, PREVIOUS_RUNS_DIR } from './task-run-archive';
import { resetSpecDirToInitialState } from './ipc-handlers/task/plan-file-utils';

let specDir: string;

/** Write the two files a finished run leaves behind */
function writeRun(costUsd: number, updatedAt: string): void {
  writeFileSync(path.join(specDir, 'task_logs.json'), JSON.stringify({
    spec_id: '014-task',
    created_at: updatedAt,
    updated_at: updatedAt,
    phases: {
      planning: { phase: 'planning', status: 'completed', started_at: updatedAt, completed_at: updatedAt, entries: [{ timestamp: updatedAt, type: 'text', content: 'triaged' }] },
      coding: { phase: 'coding', status: 'failed', started_at: updatedAt, completed_at: updatedAt, entries: [] },
      validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] }
    }
  }));
  writeFileSync(path.join(specDir, 'claude_run.json'), JSON.stringify({
    version: 1,
    phases: [{ name: 'triage', startedAt: updatedAt, endedAt: updatedAt, costUsd }],
    subagents: [],
    totalCostUsd: costUsd,
    updatedAt
  }));
}

beforeEach(() => {
  specDir = mkdtempSync(path.join(os.tmpdir(), 'run-archive-'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(specDir, { recursive: true, force: true });
});

describe('archiveCurrentRun', () => {
  it('moves the run out of the spec dir and numbers it', () => {
    writeRun(0.25, '2026-10-20T10:00:00.000Z');

    expect(archiveCurrentRun(specDir)).toBe(1);
    expect(existsSync(path.join(specDir, 'task_logs.json'))).toBe(false);
    expect(existsSync(path.join(specDir, 'claude_run.json'))).toBe(false);
    expect(readdirSync(path.join(specDir, PREVIOUS_RUNS_DIR, '001')).sort()).toEqual([
      'claude_run.json',
      'task_logs.json'
    ]);
  });

  it('files each further run under the next number', () => {
    writeRun(0.25, '2026-10-20T10:00:00.000Z');
    archiveCurrentRun(specDir);
    writeRun(0.5, '2026-10-21T10:00:00.000Z');

    expect(archiveCurrentRun(specDir)).toBe(2);
    expect(readdirSync(path.join(specDir, PREVIOUS_RUNS_DIR)).sort()).toEqual(['001', '002']);
  });

  it('keeps nothing when the task never ran', () => {
    expect(archiveCurrentRun(specDir)).toBeNull();
    expect(existsSync(path.join(specDir, PREVIOUS_RUNS_DIR))).toBe(false);
  });
});

describe('listPreviousRuns', () => {
  it('returns the runs oldest first with their steps and cost', () => {
    writeRun(0.25, '2026-10-20T10:00:00.000Z');
    archiveCurrentRun(specDir);
    writeRun(0.5, '2026-10-21T10:00:00.000Z');
    archiveCurrentRun(specDir);

    const runs = listPreviousRuns(specDir);

    expect(runs.map((r) => [r.index, r.archivedAt, r.totalCostUsd])).toEqual([
      [1, '2026-10-20T10:00:00.000Z', 0.25],
      [2, '2026-10-21T10:00:00.000Z', 0.5]
    ]);
    expect(runs[0].phases.map((p) => p.name)).toEqual(['triage']);
    expect(runs[0].logs?.phases.planning.entries).toHaveLength(1);
  });

  it('is empty for a task that was never started over', () => {
    expect(listPreviousRuns(specDir)).toEqual([]);
  });
});

describe('resetSpecDirToInitialState', () => {
  it('keeps the archived runs while clearing what the current run wrote', async () => {
    writeRun(0.25, '2026-10-20T10:00:00.000Z');
    archiveCurrentRun(specDir);
    writeRun(0.5, '2026-10-21T10:00:00.000Z');
    writeFileSync(path.join(specDir, 'task_metadata.json'), JSON.stringify({ userDescription: 'Do the thing' }));
    mkdirSync(path.join(specDir, 'attachments'), { recursive: true });
    writeFileSync(path.join(specDir, 'plan.md'), '# Plan');

    await resetSpecDirToInitialState(specDir, { title: 'Task', description: 'Do the thing' });

    expect(existsSync(path.join(specDir, PREVIOUS_RUNS_DIR, '001', 'task_logs.json'))).toBe(true);
    expect(existsSync(path.join(specDir, 'task_metadata.json'))).toBe(true);
    expect(existsSync(path.join(specDir, 'plan.md'))).toBe(false);
    expect(existsSync(path.join(specDir, 'claude_run.json'))).toBe(false);
    expect(listPreviousRuns(specDir)).toHaveLength(1);
  });
});
