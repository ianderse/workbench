/**
 * A task run's link to the broker (`TaskRunMessaging`): its session name, its Workbench tools
 * (one token for the whole run, all phases) and the live-run registration of each phase.
 */
import { taskSessionName } from '../../shared/utils/task-messaging';
import { appLog } from '../app-logger';
import { getTaskToolsRoute, taskToolsEntry } from '../insights/claude-code-runner';
import { openMcpToolsSession, type TaskToolsSession } from '../insights/task-tools-server';
import {
  getTaskMessagingEnv,
  markInboxRead,
  notePeerMessage,
  noteNativeSend,
  registerLiveRun,
  takeInbox,
} from './broker';
import { TASK_RUN_TOOLS, runTaskRunTool } from './tools';
import type { TaskRunMessaging } from './types';

export function createRunMessaging(projectId: string, specId: string): TaskRunMessaging {
  const sessionName = taskSessionName(projectId, specId);
  let tools: Promise<TaskToolsSession> | null = null;
  let disposed = false;

  const openTools = (): Promise<TaskToolsSession> => {
    tools ??= openMcpToolsSession({
      instructions: 'Message the parallel tasks of this Workbench project and see what they change.',
      tools: TASK_RUN_TOOLS.map(({ name, description, inputSchema, readOnly }) => ({
        name,
        description,
        inputSchema,
        annotations: { readOnlyHint: readOnly, destructiveHint: false },
      })),
      call: (name, args) => runTaskRunTool({ projectId, specId }, name, args),
    });
    return tools;
  };

  const sender = () => {
    const title = getTaskMessagingEnv()?.getTasks(projectId).find((t) => t.specId === specId)?.title;
    return { kind: 'task' as const, specId, title, sessionName };
  };

  return {
    sessionName,
    mcpServer: async (tempDir) => {
      if (disposed) return undefined;
      const route = getTaskToolsRoute();
      if (route === 'off') return undefined;
      try {
        const session = await openTools();
        return await taskToolsEntry(session.mcpServer, route, tempDir);
      } catch (error) {
        appLog.warn(`[TaskMessaging] Workbench tools unavailable for ${specId}:`, error);
        return undefined;
      }
    },
    takeInbox: () => takeInbox(projectId, specId).catch(() => []),
    markRead: (ids) => {
      void markInboxRead(projectId, specId, ids).catch((error) => appLog.warn('[TaskMessaging] Could not update the inbox:', error));
    },
    attach: (send) => {
      const end = registerLiveRun({ projectId, specId, sessionName, send });
      return (unreadIds) => {
        void end(unreadIds).catch((error) => appLog.warn('[TaskMessaging] Could not requeue unread messages:', error));
      };
    },
    inputRead: (id) => {
      void markInboxRead(projectId, specId, [id]).catch(() => undefined);
    },
    peerMessage: (msgId) => notePeerMessage(projectId, specId, msgId),
    nativeSend: (to, text, toolResult, isError) => {
      void noteNativeSend({ projectId, from: sender(), to, text, toolResult, isError })
        .catch((error) => appLog.warn('[TaskMessaging] Could not deliver a native message:', error));
    },
    dispose: () => {
      disposed = true;
      void tools?.then((session) => session.close()).catch(() => undefined);
    },
  };
}
