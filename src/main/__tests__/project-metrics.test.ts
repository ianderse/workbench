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
  autoBuildPath: '.auto-claude',
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
    const specs = path.join(initialized, '.auto-claude', 'specs');
    mkdirSync(path.join(specs, '001-one'), { recursive: true });
    mkdirSync(path.join(specs, '002-two'), { recursive: true });
    mkdirSync(path.join(specs, '003-never-ran'), { recursive: true });
    writeFileSync(path.join(specs, '001-one', 'claude_run.json'), JSON.stringify({ totalCostUsd: 0.25 }));
    writeFileSync(path.join(specs, '002-two', 'claude_run.json'), JSON.stringify({ totalCostUsd: 1.5 }));

    const empty = path.join(root, 'b');
    mkdirSync(path.join(empty, '.auto-claude'), { recursive: true });

    const notInitialized = path.join(root, 'c');
    mkdirSync(notInitialized, { recursive: true });

    const metrics = await getProjectCostMetrics([
      project('a', initialized),
      project('b', empty),
      project('c', notInitialized),
    ]);

    expect(metrics).toEqual([
      { projectId: 'a', name: 'a', path: initialized, taskCount: 3, totalCostUsd: 1.75 },
      { projectId: 'b', name: 'b', path: empty, taskCount: 0, totalCostUsd: 0 },
    ]);
  });
});
