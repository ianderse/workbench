/**
 * Insights prompts
 * ================
 *
 * System prompt, conversation folding and task-suggestion parsing for the Insights chat.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

  const indexPath = join(projectDir, '.auto-claude', 'project_index.json');
  if (existsSync(indexPath)) {
    try {
      const index = safeParseJson<Record<string, unknown>>(readFileSync(indexPath, 'utf-8'));
      if (index) {
        const summary = {
          project_root: index.project_root ?? '',
          project_type: index.project_type ?? 'unknown',
          services: Object.keys((index.services as Record<string, unknown>) ?? {}),
          infrastructure: index.infrastructure ?? {},
        };
        contextParts.push(`## Project Structure\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``);
      }
    } catch {
      // Ignore read errors
    }
  }

  const tasksPath = join(projectDir, '.auto-claude', DATA_DIR_NAMES.tasks);
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
export function buildSystemPrompt(projectDir: string): string {
  const context = loadProjectContext(projectDir);

  return `You are an AI assistant helping developers understand and work with their codebase.
You have access to the following project context:

${context}

Your capabilities:
1. Answer questions about the codebase structure, patterns, and architecture
2. Suggest improvements, features, or bug fixes based on the code
3. Help plan implementation of new features
4. Provide code examples and explanations

You can read files but you cannot change anything in this conversation.

When the user asks you to create a task, wants to turn the conversation into a task, or when you believe creating a task would be helpful, output a task suggestion in this exact format on a SINGLE LINE:
__TASK_SUGGESTION__:{"title": "Task title here", "description": "Detailed description of what the task involves"}

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
  return '';
}
