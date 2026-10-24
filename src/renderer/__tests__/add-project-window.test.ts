/**
 * Adding a project must leave this window on the project it was showing.
 *
 * A window shows one project, so opening another one asks first ("This window" or "New
 * window"). Switching while the question is still on screen answered it in advance: "New
 * window" then only focused this window, and the project it had been showing lost its window.
 * The project-list reload that every window runs after a project is added must not undo the
 * answer either.
 *
 * The store is imported fresh for every test, because it remembers whether the window has set
 * its own tabs yet - which is exactly what these tests are about.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '../../shared/types';

function project(id: string): Project {
  return {
    id,
    name: id,
    path: `/path/to/${id}`,
    autoBuildPath: '.workbench',
    createdAt: new Date(),
    updatedAt: new Date()
  } as Project;
}

const one = project('project-1');
const two = project('project-2');
const three = project('project-3');

const api = {
  assignedProjectId: null as string | null,
  addProject: vi.fn(),
  getProjects: vi.fn(),
  getTabState: vi.fn(),
  saveTabState: vi.fn()
};

/** A store with no history, showing project-1 in a window that was not opened for a project */
async function showingProjectOne(): Promise<typeof import('../stores/project-store')> {
  vi.resetModules();
  const store = await import('../stores/project-store');
  store.useProjectStore.setState({
    projects: [one],
    selectedProjectId: 'project-1',
    isLoading: false,
    error: null,
    openProjectIds: ['project-1'],
    activeProjectId: 'project-1',
    tabOrder: ['project-1']
  });
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  // A window opened for a project keeps its choice in session storage, which outlives a module
  // reset, so every test starts with a window that has chosen nothing yet
  sessionStorage.clear();
  api.assignedProjectId = null;
  api.addProject.mockResolvedValue({ success: true, data: two });
  api.getProjects.mockResolvedValue({ success: true, data: [one, two] });
  api.saveTabState.mockResolvedValue({ success: true });
  // What the main process has on file: the tab state as it was before project-2 was added
  api.getTabState.mockResolvedValue({
    success: true,
    data: { openProjectIds: ['project-1'], activeProjectId: 'project-1', tabOrder: ['project-1'] }
  });
  (window as unknown as { electronAPI: typeof api }).electronAPI = api;
});

describe('adding a project', () => {
  it('adds it to the list without moving this window onto it', async () => {
    const { useProjectStore, addProject } = await showingProjectOne();

    const added = await addProject('/path/to/project-2');

    expect(added?.id).toBe('project-2');
    const state = useProjectStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(['project-1', 'project-2']);
    // The window still shows what it showed before, so "New window" has a project to leave here
    expect(state.activeProjectId).toBe('project-1');
    expect(state.selectedProjectId).toBe('project-1');
    expect(state.openProjectIds).toEqual(['project-1']);
    expect(state.tabOrder).toEqual(['project-1']);
  });

  it('keeps the tab opened for it when the answer was "This window"', async () => {
    const { useProjectStore, addProject, loadProjects } = await showingProjectOne();
    await addProject('/path/to/project-2');

    // "This window": the board and Settings both move to the new project
    useProjectStore.getState().openProjectTab('project-2');
    useProjectStore.getState().setActiveProject('project-2');

    // The project list changed, so every window reloads it - with the stored tab state from
    // before the new tab existed
    await loadProjects();

    const state = useProjectStore.getState();
    expect(state.activeProjectId).toBe('project-2');
    expect(state.selectedProjectId).toBe('project-2');
    expect(state.openProjectIds).toContain('project-2');
    expect(state.tabOrder).toContain('project-2');
  });

  it('still restores the stored tabs in a window that has none of its own', async () => {
    const { useProjectStore, loadProjects } = await showingProjectOne();
    useProjectStore.setState({ openProjectIds: [], activeProjectId: null, tabOrder: [] });

    await loadProjects();

    const state = useProjectStore.getState();
    expect(state.openProjectIds).toEqual(['project-1']);
    expect(state.tabOrder).toEqual(['project-1']);
    expect(state.activeProjectId).toBe('project-1');
  });
});

describe('removing a project', () => {
  it('moves a window opened for it onto another project', async () => {
    api.assignedProjectId = 'project-2';
    const { useProjectStore } = await showingProjectOne();
    useProjectStore.setState({
      projects: [one, two],
      openProjectIds: ['project-2'],
      tabOrder: ['project-2'],
      activeProjectId: 'project-2',
      selectedProjectId: 'project-2'
    });

    useProjectStore.getState().removeProject('project-2');

    const state = useProjectStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(['project-1']);
    expect(state.activeProjectId).toBe('project-1');
    expect(state.selectedProjectId).toBe('project-1');
    // The tab for the project that is gone goes with it, rather than sitting in the bar until
    // the next project-list reload happens to clean it up
    expect(state.openProjectIds).not.toContain('project-2');
    expect(state.tabOrder).not.toContain('project-2');
  });

  it('gives the project it moves to a tab, and remembers it, when the removed one had the only tab', async () => {
    api.assignedProjectId = 'project-2';
    const { useProjectStore, loadProjects } = await showingProjectOne();
    useProjectStore.setState({
      projects: [one, two],
      // The window shows only its own project, so nothing it can fall back to is already open
      openProjectIds: ['project-2'],
      tabOrder: ['project-2'],
      activeProjectId: 'project-2',
      selectedProjectId: 'project-2'
    });

    // `saveTabStateToMain` saves on a 100 ms debounce. Two things follow, and both matter for the
    // assertion below. An earlier test's pending timer can land during this test's `await`, because
    // `vi.resetModules()` does not cancel a timer already scheduled in a discarded module instance
    // - so the count has to start here. And a save this removal schedules would not have fired by
    // the time the assertion runs, so the debounce has to be driven for the assertion to mean
    // anything at all.
    api.saveTabState.mockClear();
    vi.useFakeTimers();

    useProjectStore.getState().removeProject('project-2');

    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();

    const state = useProjectStore.getState();
    // The board shows project-1, so the tab bar has to as well: a window whose active project
    // has no tab shows a board nothing in the bar points at
    expect(state.activeProjectId).toBe('project-1');
    expect(state.openProjectIds).toEqual(['project-1']);
    expect(state.tabOrder).toEqual(['project-1']);
    // A window opened for a project keeps its tab state in session storage rather than the
    // shared one the main process holds, so that is where it must have been recorded
    expect(sessionStorage.getItem('windowProjectId')).toBe('project-1');
    expect(api.saveTabState).not.toHaveBeenCalled();

    // Removing a project reloads the list in every window; the window's own state is the newer
    // of the two, so the tab it just opened survives. The stored state still names the removed
    // project, so restoring it would be visible rather than indistinguishable
    api.getTabState.mockResolvedValue({
      success: true,
      data: { openProjectIds: ['project-2'], activeProjectId: 'project-2', tabOrder: ['project-2'] }
    });
    api.getProjects.mockResolvedValue({ success: true, data: [one] });
    await loadProjects();

    const reloaded = useProjectStore.getState();
    expect(reloaded.activeProjectId).toBe('project-1');
    expect(reloaded.openProjectIds).toEqual(['project-1']);
    expect(reloaded.tabOrder).toEqual(['project-1']);
  });

  it('leaves a window opened for the last project showing no project', async () => {
    api.assignedProjectId = 'project-1';
    const { useProjectStore, loadProjects } = await showingProjectOne();

    useProjectStore.getState().removeProject('project-1');

    const state = useProjectStore.getState();
    expect(state.projects).toEqual([]);
    expect(state.activeProjectId).toBeNull();
    expect(state.selectedProjectId).toBeNull();
    expect(state.openProjectIds).toEqual([]);
    expect(state.tabOrder).toEqual([]);

    // Removing a project reloads the list in every window, and this one must not take its own
    // assigned project - the one just removed - for the project it should show again
    api.getProjects.mockResolvedValue({ success: true, data: [] });
    api.getTabState.mockResolvedValue({
      success: true,
      data: { openProjectIds: [], activeProjectId: null, tabOrder: [] }
    });

    await loadProjects();

    const reloaded = useProjectStore.getState();
    expect(reloaded.selectedProjectId).toBeNull();
    expect(reloaded.activeProjectId).toBeNull();
    expect(reloaded.openProjectIds).toEqual([]);
    expect(reloaded.tabOrder).toEqual([]);
  });

  it('leaves a window that was switched off the removed project on the project it shows', async () => {
    api.assignedProjectId = 'project-2';
    const { useProjectStore } = await showingProjectOne();
    useProjectStore.setState({
      projects: [one, two, three],
      openProjectIds: ['project-1', 'project-2'],
      tabOrder: ['project-1', 'project-2'],
      activeProjectId: 'project-2',
      selectedProjectId: 'project-2'
    });
    // The user switched this window off the project it was opened for and onto project-3
    useProjectStore.getState().openProjectTab('project-3');
    useProjectStore.getState().setActiveProject('project-3');
    expect(sessionStorage.getItem('windowProjectId')).toBe('project-3');

    // Another window removes project-2: the project this window was opened for, which is no
    // longer the project it shows
    useProjectStore.getState().removeProject('project-2');

    const state = useProjectStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(['project-1', 'project-3']);
    // The removal never touched what this window shows, so it stays where the user put it
    expect(state.activeProjectId).toBe('project-3');
    expect(state.selectedProjectId).toBe('project-3');
    expect(sessionStorage.getItem('windowProjectId')).toBe('project-3');
    // The project is still gone from the tab bar, which is true of every window
    expect(state.openProjectIds).toEqual(['project-1', 'project-3']);
    expect(state.tabOrder).toEqual(['project-1', 'project-3']);
  });

  it('moves a window onto a replacement when the project it was switched to is removed', async () => {
    api.assignedProjectId = 'project-1';
    const { useProjectStore } = await showingProjectOne();
    useProjectStore.setState({ projects: [one, two, three] });
    // The window was opened for project-1 and the user switched it to project-3
    useProjectStore.getState().openProjectTab('project-3');
    useProjectStore.getState().setActiveProject('project-3');

    useProjectStore.getState().removeProject('project-3');

    const state = useProjectStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(['project-1', 'project-2']);
    // What the window showed is gone, so it moves on - to a project it has a tab for, and
    // remembers that as its own choice rather than falling back to the one it was opened for
    expect(state.activeProjectId).toBe('project-1');
    expect(state.selectedProjectId).toBe('project-1');
    expect(state.openProjectIds).toEqual(['project-1']);
    expect(state.tabOrder).toEqual(['project-1']);
    expect(sessionStorage.getItem('windowProjectId')).toBe('project-1');
  });

  it('moves the window on even when session storage stops accepting writes', async () => {
    api.assignedProjectId = 'project-1';
    const { useProjectStore } = await showingProjectOne();
    useProjectStore.setState({
      projects: [one, three],
      openProjectIds: ['project-3'],
      tabOrder: ['project-3'],
      activeProjectId: 'project-3',
      selectedProjectId: 'project-3'
    });
    // The switch to project-3 was recorded while storage still worked; afterwards it refuses
    // every write, which the window has to survive rather than remembering anything
    sessionStorage.setItem('windowProjectId', 'project-3');
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    try {
      useProjectStore.getState().removeProject('project-3');
    } finally {
      blocked.mockRestore();
    }

    const state = useProjectStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(['project-1']);
    expect(state.activeProjectId).toBe('project-1');
    expect(state.selectedProjectId).toBe('project-1');
    expect(state.openProjectIds).toEqual(['project-1']);
    expect(state.tabOrder).toEqual(['project-1']);
  });
});

/**
 * The ordinary window - one that was not opened for a particular project - never reaches the
 * assigned-window branch, so removing the project it is showing has to be repaired on the way out.
 * Without that the board goes on pointing at a project that is gone, with no tab, until the next
 * project load happens to heal it.
 */
describe('removing the project an ordinary window is showing', () => {
  it('moves the active tab to a project that is left, and remembers it', async () => {
    const { useProjectStore, loadProjects } = await import('../stores/project-store');
    const [one, two] = ['project-1', 'project-2'].map((id) => project(id));
    useProjectStore.setState({
      projects: [one, two],
      openProjectIds: ['project-1', 'project-2'],
      tabOrder: ['project-1', 'project-2'],
      activeProjectId: 'project-2',
      selectedProjectId: 'project-2',
    });

    useProjectStore.getState().removeProject('project-2');

    const state = useProjectStore.getState();
    expect(state.activeProjectId).toBe('project-1');
    expect(state.openProjectIds).toEqual(['project-1']);
    expect(state.tabOrder).toEqual(['project-1']);

    // And it survives the project-list reload that follows a removal. The stored tab state is the
    // one from before the removal on purpose: restored over the window's own it would put the
    // deleted project back, so this assertion only means something while they differ
    api.getTabState.mockResolvedValue({
      success: true,
      data: { openProjectIds: ['project-1', 'project-2'], activeProjectId: 'project-2', tabOrder: ['project-1', 'project-2'] }
    });
    api.getProjects.mockResolvedValue({ success: true, data: [one] });
    await loadProjects();
    expect(useProjectStore.getState().activeProjectId).toBe('project-1');
    expect(useProjectStore.getState().openProjectIds).toEqual(['project-1']);
  });

  it('leaves the active tab alone when some other project is removed', async () => {
    const { useProjectStore } = await import('../stores/project-store');
    const [one, two] = ['project-1', 'project-2'].map((id) => project(id));
    useProjectStore.setState({
      projects: [one, two],
      openProjectIds: ['project-1', 'project-2'],
      tabOrder: ['project-1', 'project-2'],
      activeProjectId: 'project-2',
      selectedProjectId: 'project-2',
    });

    useProjectStore.getState().removeProject('project-1');

    expect(useProjectStore.getState().activeProjectId).toBe('project-2');
  });
});
