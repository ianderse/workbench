/**
 * Workbench tools of a task run
 * =============================
 *
 * The MCP tools a task's Claude Code session gets (server `workbench`, tools
 * `mcp__workbench__<name>`), served by the app's local tools server with a token per run:
 *
 *   message_task         send a message to another task of the project
 *   list_parallel_tasks  the project's other unmerged tasks: status, session, files, live or not
 */
import { taskSessionName } from '../../shared/utils/task-messaging';
import type { TaskStatus } from '../../shared/types';
import { foldTaskChangelog, getTaskChangelogPath, readTaskChangelog } from '../task-changelog';
import { MAX_MESSAGE_LENGTH, deliver, getTaskMessagingEnv, isTaskLive, statusLabel } from './broker';

export interface TaskRunToolContext {
  projectId: string;
  /** The task whose session calls the tools */
  specId: string;
}

/** Tool names as the session sees them, for `--allowedTools` (plan mode needs them pre-approved) */
export const TASK_RUN_TOOL_NAMES = ['message_task', 'list_parallel_tasks'] as const;

const PARALLEL_STATUSES = new Set<TaskStatus>(['queue', 'in_progress', 'ai_review', 'human_review', 'pr_created', 'error']);
const MAX_FILES = 40;
export const PARALLEL_TASKS_RESULT_MAX_CHARS = 8_000;

function shortText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export interface TaskRunTool {
  name: (typeof TASK_RUN_TOOL_NAMES)[number];
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  run: (context: TaskRunToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

async function messageTask(context: TaskRunToolContext, args: Record<string, unknown>): Promise<string> {
  const target = typeof args.task === 'string' ? args.task : '';
  const message = typeof args.message === 'string' ? args.message : '';
  if (!target.trim()) return 'not sent: say which task (its id, number or session name)';
  const env = getTaskMessagingEnv();
  const me = env?.getTasks(context.projectId).find((t) => t.specId === context.specId);
  const outcome = await deliver(context.projectId, target, {
    kind: 'task',
    specId: context.specId,
    title: me?.title,
    sessionName: taskSessionName(context.projectId, context.specId),
  }, message);
  return outcome.detail;
}

async function listParallelTasks(context: TaskRunToolContext, args: Record<string, unknown>): Promise<unknown> {
  const env = getTaskMessagingEnv();
  const project = env?.getProject(context.projectId);
  if (!env || !project) return { tasks: [], note: 'The project is not open in Workbench' };
  const fold = foldTaskChangelog(await readTaskChangelog(getTaskChangelogPath(project.path, project.autoBuildPath)));
  const allTasks = env.getTasks(context.projectId);
  const me = allTasks.find((t) => t.specId === context.specId);
  const dependencies = new Set(me?.metadata?.dependsOnTaskIds ?? []);
  const isDependency = (t: (typeof allTasks)[number]) => dependencies.has(t.id) || dependencies.has(t.specId);
  const ownFiles = new Set<string>(fold.get(context.specId)?.files ?? []);
  const fileFilter = typeof args.file === 'string' ? args.file : '';
  const taskFilter = typeof args.task === 'string' ? args.task.toLowerCase() : '';
  const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.max(1, Math.min(20, Math.floor(args.limit))) : 10;
  const filesOf = (specId: string): string[] => fold.get(specId)?.files ?? [];
  const overlaps = (specId: string) => filesOf(specId).some((file) => ownFiles.has(file));
  const active = (specId: string, status: TaskStatus) => isTaskLive(context.projectId, specId) || status === 'in_progress' || status === 'ai_review';
  const matching = allTasks
    .filter((t) => t.specId !== context.specId && PARALLEL_STATUSES.has(t.status) && !t.metadata?.archivedAt &&
      fold.get(t.specId)?.state !== 'auto_merged' &&
      (!fileFilter || filesOf(t.specId).includes(fileFilter)) &&
      (!taskFilter || t.specId.toLowerCase().includes(taskFilter) || t.title.toLowerCase().includes(taskFilter)))
    .sort((a, b) => Number(isDependency(b)) - Number(isDependency(a)) ||
      Number(overlaps(b.specId)) - Number(overlaps(a.specId)) ||
      Number(active(b.specId, b.status)) - Number(active(a.specId, a.status)) ||
      Number(filesOf(b.specId).length > 0) - Number(filesOf(a.specId).length > 0) ||
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() || a.specId.localeCompare(b.specId));
  const candidates = matching.slice(offset, offset + limit)
    .map((t) => {
      const files = [...filesOf(t.specId)].sort((a, b) => Number(b === fileFilter) - Number(a === fileFilter) ||
        Number(ownFiles.has(b)) - Number(ownFiles.has(a)));
      const shown: string[] = [];
      for (const file of files.slice(0, MAX_FILES)) {
        // Preserve exact paths: omit oversized entries rather than presenting a truncated path.
        if (JSON.stringify([...shown, file], null, 2).length <= 1_200) shown.push(file);
      }
      const baseBranch = t.metadata?.baseBranch || project.settings?.mainBranch;
      return {
        task: t.specId,
        title: shortText(t.title, 160),
        status: statusLabel(t.status),
        session: taskSessionName(context.projectId, t.specId),
        runningNow: isTaskLive(context.projectId, t.specId),
        baseBranch: baseBranch && baseBranch.length <= 240 ? baseBranch : undefined,
        ...(baseBranch && baseBranch.length > 240 ? { baseBranchOmitted: true } : {}),
        files: shown,
        ...(files.length > shown.length ? { moreFiles: files.length - shown.length } : {}),
      };
    });
  const result = (tasks: typeof candidates, consumed: number, oversizedTasksOmitted: number) => ({
    you: { task: context.specId, session: taskSessionName(context.projectId, context.specId) },
    tasks,
    total: matching.length,
    offset,
    hasMore: offset + consumed < matching.length,
    ...(offset + consumed < matching.length ? { nextOffset: offset + consumed } : {}),
    ...(oversizedTasksOmitted ? { oversizedTasksOmitted, note: 'Oversized task records could not fit the response budget and were skipped' } : {}),
    ...(matching.length === 0 ? { note: fileFilter || taskFilter ? 'No unmerged tasks match the filters' : 'No other task has unmerged changes right now' } : {}),
  });
  const shown: typeof candidates = [];
  let consumed = 0;
  let oversizedTasksOmitted = 0;
  for (const task of candidates) {
    // Match the pretty JSON sent by the tools server, including pagination metadata.
    if (JSON.stringify(result([...shown, task], consumed + 1, oversizedTasksOmitted), null, 2).length > PARALLEL_TASKS_RESULT_MAX_CHARS) {
      if (shown.length) break;
      // A malformed or unusually long exact task ID must not create a stuck pagination cursor.
      // Omit this record explicitly and advance; shown IDs and paths are never truncated.
      consumed++;
      oversizedTasksOmitted++;
      continue;
    }
    shown.push(task);
    consumed++;
  }
  return result(shown, consumed, oversizedTasksOmitted);
}

export const TASK_RUN_TOOLS: TaskRunTool[] = [
  {
    name: 'message_task',
    description:
      'Send a short message to another task of this project. Workbench delivers it whatever state the task is in: ' +
      'a running task reads it at its next turn, a task between steps or not started reads it when it next runs. Use it when your change affects ' +
      "files, APIs or schemas the other task works with, when you are blocked on something it will settle, or to answer a question it sent you. " +
      'Returns what happened: delivered, queued or not sent (and why).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task: its id ("012-add-login"), number ("012"), or session name ("wb-…")' },
        message: { type: 'string', description: `The message, up to ${MAX_MESSAGE_LENGTH} characters. Be specific and brief` },
      },
      required: ['task', 'message'],
      additionalProperties: false,
    },
    // It never changes the project's files, and plan mode only lets read-only tools run
    readOnly: true,
    run: messageTask,
  },
  {
    name: 'list_parallel_tasks',
    description:
      "The project's other tasks whose changes are not merged yet: id, title, status, session name, whether it runs right now, its base branch " +
      'and the files its branch changes. Results are bounded and paginated; use file for an exact repo-relative path or task to search an id/title. ' +
      'Check relevant files before editing. Follow nextOffset only when you need more tasks; moreFiles means some paths were omitted. Dependencies and known overlaps come first.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Only tasks changing this exact repo-relative file path' },
        task: { type: 'string', description: 'Only tasks whose id or title contains this text (case insensitive)' },
        offset: { type: 'integer', minimum: 0, description: 'Pagination offset; use nextOffset from the previous result' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum tasks to return, default 10; the size budget may return fewer' },
      },
      additionalProperties: false,
    },
    readOnly: true,
    run: listParallelTasks,
  },
];

/** Run a task-run tool; unknown tools throw */
export async function runTaskRunTool(context: TaskRunToolContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = TASK_RUN_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(context, args);
}
