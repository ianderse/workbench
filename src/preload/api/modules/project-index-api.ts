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
  /** Give the project a CLAUDE.md: the one set aside while the index was off, else a `/init` run */
  buildProjectIndex: (projectId: string, restore?: boolean) => Promise<IPCResult<ProjectIndexInfo>>;
  /** Whether a project index build is running for the project */
  isProjectIndexBuilding: (projectId: string) => Promise<IPCResult<boolean>>;
  /** Move the project's CLAUDE.md aside, which is what switching Use CLAUDE.md off does */
  stashProjectIndex: (projectId: string) => Promise<IPCResult>;
}

export const createProjectIndexAPI = (): ProjectIndexAPI => ({
  getProjectIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.PROJECT_INDEX_GET, projectId),
  buildProjectIndex: (projectId: string, restore?: boolean) => invokeIpc(IPC_CHANNELS.PROJECT_INDEX_BUILD, projectId, restore),
  isProjectIndexBuilding: (projectId: string) => invokeIpc(IPC_CHANNELS.PROJECT_INDEX_IS_BUILDING, projectId),
  stashProjectIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.PROJECT_INDEX_STASH, projectId),
});
