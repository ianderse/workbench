/**
 * Watching what Metrics is read from, so the page shows what an agent window just spent.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { stopWatchingProjectMetrics, watchProjectMetrics } from '../project-metrics-watcher';
import type { Project } from '../../shared/types';

let configRoot = '';
// Only the temp config dir holds transcripts in a test; the profile manager is not running
vi.mock('../claude-profile/profile-config-dirs', () => ({
  claudeConfigDirs: () => [configRoot],
}));

/** Waits for the watcher to settle and report (its own delay is 1.5s) */
const reported = async (onChange: Mock<() => void>): Promise<boolean> => {
  for (let waited = 0; waited < 4000; waited += 100) {
    if (onChange.mock.calls.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

describe('watching a project\'s metrics', () => {
  let root: string;
  let project: Project;
  let transcript: string;
  let onChange: Mock<() => void>;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'metrics-watch-'));
    configRoot = path.join(root, '.claude');
    onChange = vi.fn<() => void>();

    const projectPath = path.join(root, 'project');
    mkdirSync(path.join(projectPath, '.workbench'), { recursive: true });
    project = { id: 'p1', name: 'Project', path: projectPath } as Project;

    writeFileSync(
      path.join(projectPath, '.workbench', 'agent-sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [{ sessionId: 'abc', cwd: projectPath, startedAt: '2026-10-21T09:00:00.000Z' }],
      })
    );

    const sessions = path.join(configRoot, 'projects', projectPath.replace(/\//g, '-'));
    mkdirSync(sessions, { recursive: true });
    transcript = path.join(sessions, 'abc.jsonl');
    writeFileSync(transcript, '{"type":"user"}\n');
  });

  afterEach(() => {
    stopWatchingProjectMetrics();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a change when a window\'s session writes another answer', async () => {
    await watchProjectMetrics([project], onChange);

    appendFileSync(transcript, '{"type":"assistant"}\n');

    expect(await reported(onChange)).toBe(true);
  });

  it('reports a change when a window records a session it just started', async () => {
    await watchProjectMetrics([project], onChange);

    writeFileSync(path.join(project.path, '.workbench', 'agent-sessions.json'), '{"version":1,"sessions":[]}');

    expect(await reported(onChange)).toBe(true);
  });

  it('reports nothing once the page that asked for the watch is gone', async () => {
    await watchProjectMetrics([project], onChange);
    stopWatchingProjectMetrics();

    appendFileSync(transcript, '{"type":"assistant"}\n');

    expect(await reported(onChange)).toBe(false);
  });

  it('watches a project that has no sessions yet without failing', async () => {
    const empty = path.join(root, 'empty');
    mkdirSync(path.join(empty, '.workbench'), { recursive: true });

    await watchProjectMetrics([{ id: 'p2', name: 'Empty', path: empty } as Project], onChange);

    writeFileSync(path.join(empty, '.workbench', 'agent-sessions.json'), '{"version":1,"sessions":[]}');
    expect(await reported(onChange)).toBe(true);
  });
});
