/**
 * Task suggestions in a Claude page reply
 *
 * Claude suggests a task with a line `__TASK_SUGGESTION__:{"title": ..., "description": ...}`
 * (one JSON object on one line). The app turns each line into a card with a Create task button,
 * so the lines themselves are taken out of the reply that is saved and shown.
 */

export const TASK_SUGGESTION_PREFIX = '__TASK_SUGGESTION__:';

/** A task Claude suggested */
export interface TaskSuggestion {
  title: string;
  description: string;
}

/** Every task suggestion in a reply, in order (lines that aren't valid suggestions are skipped) */
export function extractTaskSuggestions(text: string): TaskSuggestion[] {
  const suggestions: TaskSuggestion[] = [];
  for (const line of text.split('\n')) {
    const at = line.indexOf(TASK_SUGGESTION_PREFIX);
    if (at === -1) continue;
    const suggestion = parseSuggestion(line.slice(at + TASK_SUGGESTION_PREFIX.length).trim());
    if (suggestion) suggestions.push(suggestion);
  }
  return suggestions;
}

function parseSuggestion(json: string): TaskSuggestion | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
    return title && description ? { title, description } : null;
  } catch {
    return null;
  }
}

/**
 * The reply without its suggestion lines (they become cards). While a reply streams, a line
 * that has only begun the marker is left out too, so it never flashes up
 */
export function stripTaskSuggestions(text: string): string {
  const lines = text.split('\n');
  const last = lines[lines.length - 1].trim();
  const kept = lines.filter((line, index) => {
    if (line.includes(TASK_SUGGESTION_PREFIX)) return false;
    // The marker still being written at the end of a streaming reply
    return !(index === lines.length - 1 && last.length >= 2 && TASK_SUGGESTION_PREFIX.startsWith(last));
  });
  return kept.join('\n').replace(/\s+$/, '');
}
