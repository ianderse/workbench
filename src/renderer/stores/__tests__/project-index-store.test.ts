/**
 * @vitest-environment jsdom
 */

/**
 * Use CLAUDE.md from the project page: switching it off moves the project's CLAUDE.md aside rather
 * than deleting it. A move that failed leaves the file where every session reads it, so the store
 * says so instead of reporting the project as having stopped using one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProjectIndexInfo } from '../../../shared/types/cli';

const info: ProjectIndexInfo = { lines: 42, builtAt: '2026-10-20T00:00:00.000Z' };

const api = {
  getProjectIndex: vi.fn(async () => ({ success: true, data: info })),
  isProjectIndexBuilding: vi.fn(async () => ({ success: true, data: false })),
  stashProjectIndex: vi.fn(async (): Promise<{ success: boolean }> => ({ success: true })),
  buildProjectIndex: vi.fn(async () => ({ success: true, data: info })),
};
(window as unknown as { electronAPI: typeof api }).electronAPI = api;

const { useProjectIndexStore } = await import('../project-index-store');
const state = () => useProjectIndexStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  api.stashProjectIndex.mockResolvedValue({ success: true });
  api.getProjectIndex.mockResolvedValue({ success: true, data: info });
  useProjectIndexStore.setState({ index: {}, building: {}, buildError: {} });
});

describe('moving the project index aside', () => {
  it('reports the move and forgets the file', async () => {
    await expect(state().remove('p1')).resolves.toBe(true);
    expect(state().index.p1).toBeNull();
  });

  it('reports a move that failed, and says the file is still there', async () => {
    api.stashProjectIndex.mockResolvedValue({ success: false });

    await expect(state().remove('p1')).resolves.toBe(false);
    // Refreshed from disk rather than assumed gone, so the row keeps showing the file
    expect(api.getProjectIndex).toHaveBeenCalledWith('p1');
    expect(state().index.p1).toEqual(info);
  });

  it('reports a move that threw as a failure too', async () => {
    api.stashProjectIndex.mockRejectedValue(new Error('EACCES'));

    await expect(state().remove('p1')).resolves.toBe(false);
    expect(state().index.p1).toEqual(info);
  });
});
