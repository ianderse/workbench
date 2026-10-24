/**
 * "New window" for a project that was just added opens a second window and leaves this one on
 * the project it was showing.
 *
 * Adding the project used to select it straight away, so by the time the question appeared the
 * window had already answered it: "New window" only focused this window, and the project it had
 * been showing was left with no window at all.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '../../shared/i18n';
import type { Project } from '../../shared/types';
import { useProjectStore } from '../stores/project-store';
import { App } from '../App';

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/path/to/${id}`,
    autoBuildPath: '.workbench',
    createdAt: new Date(),
    updatedAt: new Date()
  } as Project;
}

const alpha = project('project-alpha', 'Alpha');
const beta = project('project-beta', 'Beta');

const openProjectWindow = vi.fn();

/**
 * The handful of calls this flow depends on. Everything else the app asks for while it starts
 * up is answered by the fallback, which stands in for an IPC call that did nothing: the test is
 * about the window's own decision, not about what any of those calls return.
 */
function electronApiStub(): Record<string | symbol, unknown> {
  const api: Record<string | symbol, unknown> = {
    assignedProjectId: null,
    getProjects: () => Promise.resolve({ success: true, data: [alpha] }),
    getTabState: () =>
      Promise.resolve({
        success: true,
        data: {
          openProjectIds: ['project-alpha'],
          activeProjectId: 'project-alpha',
          tabOrder: ['project-alpha']
        }
      }),
    saveTabState: () => Promise.resolve({ success: true }),
    getAppVersion: () => Promise.resolve('1.0.0'),
    selectDirectory: () => Promise.resolve('/path/to/project-beta'),
    addProject: () => Promise.resolve({ success: true, data: beta }),
    detectMainBranch: () => Promise.resolve({ success: true, data: 'main' }),
    hasGraphifyGraph: () => Promise.resolve({ success: true, data: false }),
    isGraphifyEnabled: () => Promise.resolve({ success: true, data: false }),
    listProjectWindows: () =>
      Promise.resolve({ success: true, data: [{ windowId: 1, projectId: 'project-alpha' }] }),
    openProjectWindow: (projectId: string) => {
      openProjectWindow(projectId);
      return Promise.resolve({ success: true, data: { focused: false } });
    }
  };

  return new Proxy(api, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) =>
        typeof args[0] === 'function'
          ? () => {}
          : Promise.resolve({ success: true, data: undefined });
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({
    projects: [],
    selectedProjectId: null,
    openProjectIds: [],
    activeProjectId: null,
    tabOrder: []
  });

  (window as unknown as { electronAPI: unknown }).electronAPI = electronApiStub();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn()
  }) as unknown as typeof window.matchMedia;
});

describe('adding a project and choosing "New window"', () => {
  it('opens a window for it and keeps this window on its own project', async () => {
    render(<App />);

    // The sidebar's Projects row is labelled with the project this window shows
    fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
    fireEvent.click(await screen.findByRole('button', { name: /New project/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open existing project folder' }));

    // The window shows a project already, so it asks before taking another one
    fireEvent.click(await screen.findByRole('button', { name: 'New window' }));

    expect(openProjectWindow).toHaveBeenCalledWith('project-beta');
    const state = useProjectStore.getState();
    expect(state.activeProjectId).toBe('project-alpha');
    expect(state.selectedProjectId).toBe('project-alpha');
    expect(state.openProjectIds).not.toContain('project-beta');
    // The new project is on the list all the same, so its card is there to open later
    expect(state.projects.map((p) => p.id)).toEqual(['project-alpha', 'project-beta']);
  });
});
