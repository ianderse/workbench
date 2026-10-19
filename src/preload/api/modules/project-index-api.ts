/**
 * Project index API for the renderer: the project's CLAUDE.md, written by Claude Code's `/init`
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { ProjectIndexInfo } from '../../../shared/types/cli';
import { invokeIpc } from './ipc-utils';

export interface ProjectIndexAPI {
  /** The project's CLAUDE.md stats, or null when it has none */
  getProjectIndex: (projectId: string) => Promise<IPCResult<ProjectIndexInfo | null>>;
  /** Write (or rewrite) the project's CLAUDE.md with a short `/init` run */
  buildProjectIndex: (projectId: string) => Promise<IPCResult<ProjectIndexInfo>>;
  /** Whether a project index build is running for the project */
  isProjectIndexBuilding: (projectId: string) => Promise<IPCResult<boolean>>;
  /** Remove the project's CLAUDE.md, which is what switching Use CLAUDE.md off does */
  deleteProjectIndex: (projectId: string) => Promise<IPCResult>;
}

export const createProjectIndexAPI = (): ProjectIndexAPI => ({
  getProjectIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.PROJECT_INDEX_GET, projectId),
  buildProjectIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.PROJECT_INDEX_BUILD, projectId),
  isProjectIndexBuilding: (projectId: string) => invokeIpc(IPC_CHANNELS.PROJECT_INDEX_IS_BUILDING, projectId),
  deleteProjectIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.PROJECT_INDEX_DELETE, projectId),
});
