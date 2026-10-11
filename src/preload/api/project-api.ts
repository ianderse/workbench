import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  Project,
  ProjectSettings,
  IPCResult,
  InitializationResult,
  AutoBuildVersionInfo,
  ProjectEnvConfig,
  GitStatus,
  KanbanPreferences,
  GitBranchDetail,
  ProjectCostMetrics
} from '../../shared/types';

// Tab state interface (persisted in main process)
export interface TabState {
  openProjectIds: string[];
  activeProjectId: string | null;
  tabOrder: string[];
}

export interface ProjectAPI {
  // Project Management
  addProject: (projectPath: string) => Promise<IPCResult<Project>>;
  removeProject: (projectId: string) => Promise<IPCResult>;
  getProjects: () => Promise<IPCResult<Project[]>>;
  getProjectCostMetrics: () => Promise<IPCResult<ProjectCostMetrics[]>>;
  updateProjectSettings: (
    projectId: string,
    settings: Partial<ProjectSettings>
  ) => Promise<IPCResult>;
  initializeProject: (projectId: string) => Promise<IPCResult<InitializationResult>>;
  checkProjectVersion: (projectId: string) => Promise<IPCResult<AutoBuildVersionInfo>>;

  // Tab State (persisted in main process for reliability)
  getTabState: () => Promise<IPCResult<TabState>>;
  saveTabState: (tabState: TabState) => Promise<IPCResult>;

  // Kanban Preferences (persisted in main process per project)
  getKanbanPreferences: (projectId: string) => Promise<IPCResult<KanbanPreferences | null>>;
  saveKanbanPreferences: (projectId: string, preferences: KanbanPreferences) => Promise<IPCResult>;

  // Context Operations
  getProjectContext: (projectId: string) => Promise<IPCResult<unknown>>;
  refreshProjectIndex: (projectId: string) => Promise<IPCResult<unknown>>;

  // Environment Configuration
  getProjectEnv: (projectId: string) => Promise<IPCResult<ProjectEnvConfig>>;
  updateProjectEnv: (projectId: string, config: Partial<ProjectEnvConfig>) => Promise<IPCResult>;

  // Dialog Operations
  selectDirectory: () => Promise<string | null>;
  createProjectFolder: (
    location: string,
    name: string,
    initGit: boolean
  ) => Promise<IPCResult<import('../../shared/types').CreateProjectFolderResult>>;
  getDefaultProjectLocation: () => Promise<string | null>;

  // Git Operations
  /** @deprecated Use getGitBranchesWithInfo for structured branch data with type indicators */
  getGitBranches: (projectPath: string) => Promise<IPCResult<string[]>>;
  /** Get branches with structured type information (local vs remote) */
  /** Local and remote branches; fetchRemote runs `git fetch` first (refresh buttons only) */
  getGitBranchesWithInfo: (projectPath: string, fetchRemote?: boolean) => Promise<IPCResult<GitBranchDetail[]>>;
  getCurrentGitBranch: (projectPath: string) => Promise<IPCResult<string | null>>;
  detectMainBranch: (projectPath: string) => Promise<IPCResult<string | null>>;
  checkGitStatus: (projectPath: string) => Promise<IPCResult<GitStatus>>;
  initializeGit: (projectPath: string) => Promise<IPCResult<InitializationResult>>;
}

export const createProjectAPI = (): ProjectAPI => ({
  // Project Management
  addProject: (projectPath: string): Promise<IPCResult<Project>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_ADD, projectPath),

  removeProject: (projectId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_REMOVE, projectId),

  getProjects: (): Promise<IPCResult<Project[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),

  getProjectCostMetrics: (): Promise<IPCResult<ProjectCostMetrics[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_COST_METRICS),

  updateProjectSettings: (
    projectId: string,
    settings: Partial<ProjectSettings>
  ): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE_SETTINGS, projectId, settings),

  initializeProject: (projectId: string): Promise<IPCResult<InitializationResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_INITIALIZE, projectId),

  checkProjectVersion: (projectId: string): Promise<IPCResult<AutoBuildVersionInfo>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CHECK_VERSION, projectId),

  // Tab State (persisted in main process for reliability)
  getTabState: (): Promise<IPCResult<TabState>> =>
    ipcRenderer.invoke(IPC_CHANNELS.TAB_STATE_GET),

  saveTabState: (tabState: TabState): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.TAB_STATE_SAVE, tabState),

  // Kanban Preferences (persisted in main process per project)
  getKanbanPreferences: (projectId: string): Promise<IPCResult<KanbanPreferences | null>> =>
    ipcRenderer.invoke(IPC_CHANNELS.KANBAN_PREFS_GET, projectId),

  saveKanbanPreferences: (projectId: string, preferences: KanbanPreferences): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.KANBAN_PREFS_SAVE, projectId, preferences),

  // Context Operations
  getProjectContext: (projectId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_GET, projectId),

  refreshProjectIndex: (projectId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_REFRESH_INDEX, projectId),


  // Environment Configuration
  getProjectEnv: (projectId: string): Promise<IPCResult<ProjectEnvConfig>> =>
    ipcRenderer.invoke(IPC_CHANNELS.ENV_GET, projectId),

  updateProjectEnv: (projectId: string, config: Partial<ProjectEnvConfig>): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.ENV_UPDATE, projectId, config),

  // Dialog Operations
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY),

  createProjectFolder: (
    location: string,
    name: string,
    initGit: boolean
  ): Promise<IPCResult<import('../../shared/types').CreateProjectFolderResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_CREATE_PROJECT_FOLDER, location, name, initGit),

  getDefaultProjectLocation: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_GET_DEFAULT_PROJECT_LOCATION),

  // Git Operations
  getGitBranches: (projectPath: string): Promise<IPCResult<string[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_BRANCHES, projectPath),

  getGitBranchesWithInfo: (projectPath: string, fetchRemote?: boolean): Promise<IPCResult<GitBranchDetail[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_BRANCHES_WITH_INFO, projectPath, fetchRemote),

  getCurrentGitBranch: (projectPath: string): Promise<IPCResult<string | null>> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_CURRENT_BRANCH, projectPath),

  detectMainBranch: (projectPath: string): Promise<IPCResult<string | null>> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_DETECT_MAIN_BRANCH, projectPath),

  checkGitStatus: (projectPath: string): Promise<IPCResult<GitStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CHECK_STATUS, projectPath),

  initializeGit: (projectPath: string): Promise<IPCResult<InitializationResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_INITIALIZE, projectPath)
});
