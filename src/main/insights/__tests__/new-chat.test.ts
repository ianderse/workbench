import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from '../session-manager';
import type { SessionStorage } from '../session-storage';
import type { InsightsPaths } from '../paths';

function storage(currentSessionId: string | null) {
  return {
    current: currentSessionId,
    saved: [] as string[],
    migrateOldSession: vi.fn(),
    getCurrentSessionId() { return this.current; },
    saveCurrentSessionId(_path: string, id: string) { this.current = id; },
    clearCurrentSessionId() { this.current = null; },
    loadSessionById: (_path: string, id: string) =>
      ({ id, projectId: 'p1', title: 'Old', messages: [], createdAt: new Date(), updatedAt: new Date() }),
    saveSession(_path: string, session: { id: string }) { this.saved.push(session.id); },
    deleteSession: () => true,
    deleteSessions: (_path: string, ids: string[]) => ({ deletedIds: ids, failedIds: [] }),
    listSessions: () => [{ id: 'session-other' }],
  };
}

describe('SessionManager new chat', () => {
  it('opens a new chat without saving a conversation', () => {
    const store = storage('session-old');
    const manager = new SessionManager(store as unknown as SessionStorage, {} as InsightsPaths);
    expect(manager.loadSession('p1', '/project')?.id).toBe('session-old');

    manager.startNewChat('p1', '/project');

    expect(manager.loadSession('p1', '/project')).toBeNull();
    expect(store.saved).toEqual([]);
  });

  it('opens a new chat after the open chat is deleted', () => {
    const store = storage('session-old');
    const manager = new SessionManager(store as unknown as SessionStorage, {} as InsightsPaths);
    manager.loadSession('p1', '/project');

    manager.deleteSession('p1', '/project', 'session-old');

    expect(manager.loadSession('p1', '/project')).toBeNull();
  });

  it('opens a new chat after the open chat is deleted with others', () => {
    const store = storage('session-old');
    const manager = new SessionManager(store as unknown as SessionStorage, {} as InsightsPaths);
    manager.loadSession('p1', '/project');

    manager.deleteSessions('p1', '/project', ['session-old', 'session-x']);

    expect(manager.loadSession('p1', '/project')).toBeNull();
  });

  it('keeps the open chat when another one is deleted', () => {
    const store = storage('session-old');
    const manager = new SessionManager(store as unknown as SessionStorage, {} as InsightsPaths);
    manager.loadSession('p1', '/project');

    manager.deleteSession('p1', '/project', 'session-other');

    expect(manager.loadSession('p1', '/project')?.id).toBe('session-old');
  });
});
