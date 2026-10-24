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

/**
 * Makes the change and waits for the watcher to settle and report (its own delay is 1.5s). The
 * change is made again every half second: on macOS a watcher may start a moment after fs.watch
 * returns and miss a write made right away.
 */
const reported = async (onChange: Mock<() => void>, change: () => void): Promise<boolean> => {
  for (let waited = 0; waited < 4000; waited += 100) {
    if (onChange.mock.calls.length > 0) return true;
    if (waited % 500 === 0 && waited <= 2000) change();
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

    // Named as Claude Code names it: every character that is not a letter or a digit becomes a dash
    const sessions = path.join(configRoot, 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'));
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

    expect(await reported(onChange, () => appendFileSync(transcript, '{"type":"assistant"}\n'))).toBe(true);
  });

  it('reports a change when a window records a session it just started', async () => {
    await watchProjectMetrics([project], onChange);

    const recordSession = () =>
      writeFileSync(path.join(project.path, '.workbench', 'agent-sessions.json'), '{"version":1,"sessions":[]}');
    expect(await reported(onChange, recordSession)).toBe(true);
  });

  it('reports nothing once the page that asked for the watch is gone', async () => {
    await watchProjectMetrics([project], onChange);
    stopWatchingProjectMetrics();

    expect(await reported(onChange, () => appendFileSync(transcript, '{"type":"assistant"}\n'))).toBe(false);
  });

  it('watches a project that has no sessions yet without failing', async () => {
    const empty = path.join(root, 'empty');
    mkdirSync(path.join(empty, '.workbench'), { recursive: true });

    await watchProjectMetrics([{ id: 'p2', name: 'Empty', path: empty } as Project], onChange);

    const recordSession = () => writeFileSync(path.join(empty, '.workbench', 'agent-sessions.json'), '{"version":1,"sessions":[]}');
    expect(await reported(onChange, recordSession)).toBe(true);
  });
});
