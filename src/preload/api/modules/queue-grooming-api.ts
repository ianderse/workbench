/**
 * Queue grooming API for the renderer: what a merged task proposes for the tickets in Planning
 * and the Queue, and the context notes added to tickets
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { QueueProposal } from '../../../shared/types/queue-grooming';
import { createIpcListener, invokeIpc } from './ipc-utils';

export interface QueueGroomingAPI {
  /** Proposals waiting for the user (obsolete / duplicate tickets, new tasks) */
  listQueueProposals: (projectId: string) => Promise<IPCResult<QueueProposal[]>>;
  applyQueueProposal: (projectId: string, proposalId: string) => Promise<IPCResult>;
  dismissQueueProposal: (projectId: string, proposalId: string) => Promise<IPCResult>;
  /** Take a context note off a ticket (its text leaves the description) */
  undoContextNote: (projectId: string, taskId: string, noteId: string) => Promise<IPCResult>;
  /** Proposals were added, applied or dismissed */
  onQueueProposalsChanged: (callback: (projectId: string) => void) => () => void;
}

export const createQueueGroomingAPI = (): QueueGroomingAPI => ({
  listQueueProposals: (projectId: string) => invokeIpc(IPC_CHANNELS.QUEUE_PROPOSALS_LIST, projectId),
  applyQueueProposal: (projectId: string, proposalId: string) => invokeIpc(IPC_CHANNELS.QUEUE_PROPOSAL_APPLY, projectId, proposalId),
  dismissQueueProposal: (projectId: string, proposalId: string) => invokeIpc(IPC_CHANNELS.QUEUE_PROPOSAL_DISMISS, projectId, proposalId),
  undoContextNote: (projectId: string, taskId: string, noteId: string) =>
    invokeIpc(IPC_CHANNELS.QUEUE_NOTE_UNDO, projectId, taskId, noteId),
  onQueueProposalsChanged: (callback: (projectId: string) => void) =>
    createIpcListener(IPC_CHANNELS.QUEUE_PROPOSALS_CHANGED, callback),
});
