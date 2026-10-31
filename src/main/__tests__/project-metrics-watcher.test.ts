/**
 * Watching what Metrics is read from, so the page shows what an agent window just spent.
 *
 * fs.watch is replaced by a fake that records what is watched and lets the test fire the change
 * itself, and the settle delay runs on fake timers. Real file-system events arrive whenever the OS
 * delivers them (seconds late on a busy machine), which made these tests fail under a full run;
 * what is tested here is the module's own logic: what it watches, that a burst is reported once
 * after it settles, and that nothing is reported once the watch is dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from '../../shared/types';

const watchHandlers = new Map<string, () => void>();
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const watch = (target: string, _options: unknown, listener: () => void) => {
    watchHandlers.set(target, listener);
    return {
      on: () => undefined,
      close: () => {
        if (watchHandlers.get(target) === listener) watchHandlers.delete(target);
      },
    };
  };
  return { ...actual, default: { ...actual, watch }, watch };
});

let configRoot = '';
// Only the temp config dir holds transcripts in a test; the profile manager is not running
vi.mock('../claude-profile/profile-config-dirs', () => ({
  claudeConfigDirs: () => [configRoot],
}));

const { stopWatchingProjectMetrics, watchProjectMetrics } = await import('../project-metrics-watcher');

/** Fire a watched path's change, as fs.watch would */
const touch = (target: string): void => {
  const handler = watchHandlers.get(target);
  if (!handler) throw new Error(`Not watched: ${target}`);
  handler();
};

describe('watching a project\'s metrics', () => {
  let root: string;
  let project: Project;
  let dataDir: string;
  let transcript: string;
  let onChange: Mock<() => void>;

  beforeEach(() => {
    watchHandlers.clear();
    root = mkdtempSync(path.join(os.tmpdir(), 'metrics-watch-'));
    configRoot = path.join(root, '.claude');
    onChange = vi.fn<() => void>();

    const projectPath = path.join(root, 'project');
    dataDir = path.join(projectPath, '.workbench');
    mkdirSync(dataDir, { recursive: true });
    project = { id: 'p1', name: 'Project', path: projectPath } as Project;

    writeFileSync(
      path.join(dataDir, 'agent-sessions.json'),
      JSON.stringify({
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
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('watches the project\'s data directory and the transcript of each session its windows started', async () => {
    await watchProjectMetrics([project], onChange);

    expect([...watchHandlers.keys()].sort()).toEqual([dataDir, transcript].sort());
  });

  it('reports a change when a window\'s session writes another answer, once the writes settle', async () => {
    await watchProjectMetrics([project], onChange);
    vi.useFakeTimers();

    touch(transcript);
    touch(transcript);
    vi.advanceTimersByTime(1499);
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reports a change when a window records a session it just started', async () => {
    await watchProjectMetrics([project], onChange);
    vi.useFakeTimers();

    touch(dataDir);
    vi.advanceTimersByTime(1500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reports nothing once the page that asked for the watch is gone', async () => {
    await watchProjectMetrics([project], onChange);
    vi.useFakeTimers();
    // A change already settling when the page goes away is dropped with it
    touch(transcript);
    stopWatchingProjectMetrics();

    vi.advanceTimersByTime(5000);
    expect(onChange).not.toHaveBeenCalled();
    expect(watchHandlers.size).toBe(0);
  });

  it('ignores an event the OS delivers just after the watch was dropped', async () => {
    await watchProjectMetrics([project], onChange);
    const late = watchHandlers.get(transcript)!;
    stopWatchingProjectMetrics();
    vi.useFakeTimers();

    late();
    vi.advanceTimersByTime(5000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('watches a project that has no sessions yet without failing', async () => {
    const empty = path.join(root, 'empty');
    const emptyData = path.join(empty, '.workbench');
    mkdirSync(emptyData, { recursive: true });

    await watchProjectMetrics([{ id: 'p2', name: 'Empty', path: empty } as Project], onChange);
    expect([...watchHandlers.keys()]).toEqual([emptyData]);

    vi.useFakeTimers();
    touch(emptyData);
    vi.advanceTimersByTime(1500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
