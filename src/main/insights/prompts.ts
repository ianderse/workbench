/**
 * Insights prompts
 * ================
 *
 * System prompt, conversation folding and task-suggestion parsing for the Insights chat.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeParseJson } from '../utils/json-repair';
import { DATA_DIR_NAMES } from '../../shared/constants';

/** A message in the insights conversation history */
export interface InsightsMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A task suggestion extracted from the response */
export interface TaskSuggestion {
  title: string;
  description: string;
}

/** Load project context for the system prompt */
function loadProjectContext(projectDir: string): string {
  const contextParts: string[] = [];

  const tasksPath = join(projectDir, '.workbench', DATA_DIR_NAMES.tasks);
  if (existsSync(tasksPath)) {
    try {
      const taskDirs = readdirSync(tasksPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .slice(0, 10);
      if (taskDirs.length > 0) {
        contextParts.push(`## Existing Tasks\n- ${taskDirs.join('\n- ')}`);
      }
    } catch {
      // Ignore read errors
    }
  }

  return contextParts.length > 0 ? contextParts.join('\n\n') : 'No project context available yet.';
}

/** Fold the conversation history into a single prompt (each turn is a fresh run) */
export function buildConversationPrompt(message: string, history: InsightsMessage[] = []): string {
  if (history.length === 0) return message;
  const conversationContext = history
    .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
    .join('\n\n');
  return `Previous conversation:\n${conversationContext}\n\nCurrent question: ${message}`;
}

/** System prompt section for the insights chat (appended to Claude Code's own) */
/** Git hosting CLIs Claude may use in the conversation (the GitHub and GitLab buttons) */
export interface InsightsCliTools {
  github?: boolean;
  gitlab?: boolean;
}

/** What Claude can do with the git hosting CLIs turned on for the conversation */
function cliToolsPrompt(cliTools: InsightsCliTools): string {
  const clis = [
    ...(cliTools.github ? ['the GitHub CLI (`gh`)'] : []),
    ...(cliTools.gitlab ? ['the GitLab CLI (`glab`)'] : []),
  ];
  if (clis.length === 0) return '';
  return `

You can use ${clis.join(' and ')} through Bash for the project's repository: issues, pull or merge requests, reviews, CI runs, releases and the like. Every other shell command is denied.
- Read freely; create, comment, close, merge or change anything only when the user asked for exactly that, and tell them what you did (with links or numbers).
- Never delete repositories, branches, releases or other resources, and never change repository settings or secrets.
- When a command fails (not installed, not signed in, no access), say so instead of trying something else.`;
}

export function buildSystemPrompt(
  projectDir: string,
  options: { taskTools?: boolean; cliTools?: InsightsCliTools } = {}
): string {
  const context = loadProjectContext(projectDir);
  const suggestionFormat = `__TASK_SUGGESTION__:{"title": "Task title here", "description": "Detailed description of what the task involves"}`;

  // The Kanban button gives Claude the project's task tools; without it, tasks are only suggested
  const tasks = options.taskTools
    ? `5. Manage the project's tasks with the Workbench task tools (mcp__workbench__*): list and inspect tasks (status, plan, logs, validation, worktree changes), create and edit them, start, stop and retry them, move them between columns, request changes, create and merge their pull requests, archive and delete them

You can read the project's files but not change them: code changes are made by tasks. To get something done, create a task whose description gives Claude Code everything it needs, and start it when the user wants it done now.

Using the task tools:
- Act on what the user asks for, and tell them what you did (with the task ids). Look tasks up with list_tasks or get_task instead of guessing ids or states.
- Delete tasks, retry them (it discards their changes) or merge pull requests only when the user asked for exactly that. When moving a task with a worktree to Done, ask whether to keep or delete the worktree.
- When a tool fails, explain why instead of trying something else the user didn't ask for.

Suggesting tasks: when you notice something worth doing that the user did not ask for (a bug you came across, a feature, a docs update, a refactor, anything a task could do), don't create it. Suggest it instead so the user decides, with this exact format on a SINGLE LINE:
${suggestionFormat}`
    : `
You can read the project's files but not change them, and you can't create or change tasks yourself in this conversation (the user turns that on with the Kanban button).

When the user asks you to create a task, wants to turn the conversation into a task, or when you believe a task would be useful (a bug you came across, a feature, a docs update, a refactor, anything a task could do), suggest it with this exact format on a SINGLE LINE:
${suggestionFormat}`;

  return `You are an AI assistant helping developers understand and work with their codebase, inside Workbench, a desktop app where Claude Code does coding tasks autonomously, each in its own git worktree, and the user follows them on a Kanban board (Planning, Queue, In Progress, AI Review, Human Review, Done).
You have access to the following project context:

${context}

Your capabilities:
1. Answer questions about the codebase structure, patterns, and architecture
2. Suggest improvements, features, or bug fixes based on the code
3. Help plan implementation of new features
4. Provide code examples and explanations
${tasks}${cliToolsPrompt(options.cliTools ?? {})}

Be conversational and helpful. Focus on providing actionable insights and clear explanations.
Keep responses concise but informative.`;
}

const TASK_SUGGESTION_PREFIX = '__TASK_SUGGESTION__:';

/** Extract a task suggestion from the response text if present */
export function extractTaskSuggestion(text: string): TaskSuggestion | null {
  const idx = text.indexOf(TASK_SUGGESTION_PREFIX);
  if (idx === -1) return null;

  const afterPrefix = text.substring(idx + TASK_SUGGESTION_PREFIX.length);
  const lineEnd = afterPrefix.indexOf('\n');
  const jsonStr = (lineEnd === -1 ? afterPrefix : afterPrefix.substring(0, lineEnd)).trim();

  const parsed = safeParseJson<Record<string, unknown>>(jsonStr);
  if (!parsed || typeof parsed !== 'object') return null;
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
  return title && description ? { title, description } : null;
}

/** Brief description of a tool call's arguments for UI display */
export function extractToolInput(args: Record<string, unknown>): string {
  // Bash (graphify searches): the command itself
  if (args.command) {
    const command = String(args.command);
    return command.length > 80 ? `${command.slice(0, 77)}...` : command;
  }
  if (args.pattern) return `pattern: ${args.pattern}`;
  if (args.file_path) {
    const fp = String(args.file_path);
    return fp.length > 50 ? `...${fp.slice(-47)}` : fp;
  }
  if (args.path) return String(args.path);
  // Task tools: the task (and where it goes) or the new task's title
  if (args.taskId) return args.to ? `${args.taskId} → ${args.to}` : String(args.taskId);
  if (Array.isArray(args.taskIds)) return args.taskIds.join(', ');
  if (args.title) return String(args.title);
  if (args.description) {
    const description = String(args.description);
    return description.length > 80 ? `${description.slice(0, 77)}...` : description;
  }
  return '';
}
