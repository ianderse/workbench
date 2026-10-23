/**
 * Watching Metrics for a project inside WSL: fs.watch doesn't work on \\wsl.localhost paths, so
 * they are polled
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

const fsMock = vi.hoisted(() => ({
  watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()), ...fsMock }));
vi.mock('../agent-session-store', () => ({ readAgentSessions: async () => [] }));
vi.mock('../claude-profile/profile-config-dirs', () => ({ claudeConfigDirs: () => [] }));
vi.mock('../claude-code/session-spending', () => ({ findSessionTranscript: async () => null }));

import { stopWatchingProjectMetrics, watchProjectMetrics } from '../project-metrics-watcher';
import type { Project } from '../../shared/types';

afterEach(() => {
  stopWatchingProjectMetrics();
  vi.clearAllMocks();
});

describe('watching metrics of a project inside WSL', () => {
  it('polls its .workbench directory and session list instead of watching them', async () => {
    const projectPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj';
    await watchProjectMetrics([{ id: 'p1', name: 'Project', path: projectPath } as Project], vi.fn());

    const dataDir = path.join(projectPath, '.workbench');
    expect(fsMock.watch).not.toHaveBeenCalled();
    expect(fsMock.watchFile.mock.calls.map((call) => (call as unknown[])[0])).toEqual([dataDir, path.join(dataDir, 'agent-sessions.json')]);

    stopWatchingProjectMetrics();
    expect(fsMock.unwatchFile).toHaveBeenCalledTimes(2);
  });

  it('watches a project on a local drive with file system events', async () => {
    await watchProjectMetrics([{ id: 'p2', name: 'Project', path: '/home/me/local' } as Project], vi.fn());
    expect(fsMock.watch).toHaveBeenCalledTimes(1);
    expect(fsMock.watchFile).not.toHaveBeenCalled();
  });
});
