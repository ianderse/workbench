/**
 * @vitest-environment jsdom
 */

/**
 * Use Graphify from the project page: switching it on builds the graph (the switch waits for the
 * build), switching it off hides the Memory item
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GraphifyIndexInfo } from '../../../shared/types/cli';

const info: GraphifyIndexInfo = { nodes: 3, edges: 2, communities: 1, builtAt: '2026-10-16T00:00:00.000Z', version: '1.0.0' };
let finishBuild: (result: { success: boolean; data?: GraphifyIndexInfo; error?: string }) => void;

const api = {
  onGraphifyIndexUpdated: vi.fn(() => () => {}),
  hasGraphifyGraph: vi.fn(async () => ({ success: true, data: false })),
  isGraphifyEnabled: vi.fn(async () => ({ success: true, data: false })),
  setGraphifyEnabled: vi.fn(async () => ({ success: true })),
  buildGraphifyIndex: vi.fn(() => new Promise((resolve) => { finishBuild = resolve; })),
};
(window as unknown as { electronAPI: typeof api }).electronAPI = api;

const { useMemoryGraphStore } = await import('../memory-graph-store');
const state = () => useMemoryGraphStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useMemoryGraphStore.setState({ available: {}, enabled: {}, revision: {}, building: {}, buildError: {} });
});

describe('memory graph store', () => {
  it('switching Use Graphify on builds the graph and counts as building until it is done', async () => {
    const switching = state().setEnabled('p1', true);
    // Building from the first moment, so the switch can't be flipped back meanwhile
    expect(state().building.p1).toBe(true);
    expect(state().enabled.p1).toBe(true);

    await vi.waitFor(() => expect(api.buildGraphifyIndex).toHaveBeenCalledWith('p1'));
    expect(api.setGraphifyEnabled).toHaveBeenCalledWith('p1', true);
    expect(state().building.p1).toBe(true);

    finishBuild({ success: true, data: info });
    await switching;
    expect(state().building.p1).toBe(false);
    expect(state().available.p1).toBe(true);
    expect(state().buildError.p1).toBeNull();
  });

  it('keeps a failed build as the error and stops building', async () => {
    const switching = state().setEnabled('p1', true);
    await vi.waitFor(() => expect(api.buildGraphifyIndex).toHaveBeenCalled());
    finishBuild({ success: false, error: 'graphify crashed' });
    await switching;
    expect(state().building.p1).toBe(false);
    expect(state().buildError.p1).toBe('graphify crashed');
    expect(state().available.p1).toBeUndefined();
  });

  it('switching it off hides the Memory item and builds nothing', async () => {
    useMemoryGraphStore.setState({ available: { p1: true }, enabled: { p1: true } });
    await state().setEnabled('p1', false);
    expect(api.setGraphifyEnabled).toHaveBeenCalledWith('p1', false);
    expect(api.buildGraphifyIndex).not.toHaveBeenCalled();
    expect(state().available.p1).toBe(false);
    expect(state().enabled.p1).toBe(false);
  });

  it('stays off when the folder could not be created', async () => {
    api.setGraphifyEnabled.mockResolvedValueOnce({ success: false });
    await state().setEnabled('p1', true);
    expect(api.buildGraphifyIndex).not.toHaveBeenCalled();
    expect(state().building.p1).toBe(false);
    expect(state().enabled.p1).toBe(false);
  });
});
