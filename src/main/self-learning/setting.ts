/**
 * Reading the project's self-learning switch from the project itself, for the callers that hold a
 * path rather than a Project (terminals, worktree creation). The switch is kept in the project's own
 * `.workbench/settings.json`, so it survives a different app install and is visible in the checkout.
 */

import { readFile } from 'fs/promises';
import path from 'path';

/** Whether the project at this path learns from its sessions; false when unreadable or unset */
export async function isSelfLearningEnabledForPath(projectPath: string | undefined): Promise<boolean> {
  if (!projectPath) return false;
  try {
    const file = path.join(projectPath, '.workbench', 'settings.json');
    const parsed: unknown = JSON.parse(await readFile(file, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return (parsed as Record<string, unknown>).selfLearning === true;
  } catch {
    return false;
  }
}
