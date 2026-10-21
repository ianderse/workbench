/**
 * Every Claude Code session that ran in a project
 *
 * Metrics counts what a project cost, and Claude Code is used on a project in more ways than
 * Workbench starts itself: an agent window, Insights, and the user's own `claude` in a terminal
 * all spend on the same account. Claude Code keeps a transcript of each of them under
 * `<configDir>/projects/<the working directory with the separators replaced>/<sessionId>.jsonl`,
 * so the project's sessions can be found by the directory they ran in, whichever account wrote
 * them, and read like any other session (`session-spending.ts`).
 *
 * The folder name says which directory a session ran in, but not without ambiguity (a separator
 * and a dot both become a dash), so it is only used to skip the folders that cannot belong to this
 * project; what a session really ran in is read from the transcript itself.
 *
 * Two kinds of session are deliberately left out, because their cost is already counted:
 * - a session a task run owns, named in the task's `claude_run.json`
 * - any session that ran in the project's worktrees directory, which is where task runs work
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { belongsToProject, readTranscriptCwd } from '../self-improve/transcripts';
import type { TranscriptFile } from './session-spending';

/** One Claude Code session found in a project */
export interface ProjectSession extends TranscriptFile {
  sessionId: string;
  /** The account whose config dir holds the transcript */
  configDir: string;
  /** The directory the session ran in */
  cwd: string;
}

export interface FindProjectSessionsOptions {
  /** Sessions to leave out, such as the ones a task run owns */
  skip?: ReadonlySet<string>;
  /** Directories whose sessions are counted elsewhere (the project's worktrees) */
  skipUnder?: string[];
}

/**
 * How Claude Code could have named the folder of a directory: every separator and dot becomes a
 * dash. The real name is read back from the transcript, so this only has to be no narrower.
 */
function folderPrefix(directory: string): string {
  return directory
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/[/.]/g, '-');
}

/** The sessions of a project, newest transcript first */
export async function findProjectSessions(
  projectPath: string,
  configDirs: string[],
  options: FindProjectSessionsOptions = {}
): Promise<ProjectSession[]> {
  const prefix = folderPrefix(projectPath);
  const found = new Map<string, ProjectSession>();

  for (const configDir of configDirs) {
    const root = path.join(configDir, 'projects');
    let folders: string[];
    try {
      folders = await fsp.readdir(root);
    } catch {
      // This account has no sessions
      continue;
    }

    for (const folder of folders) {
      // Another project, or a directory outside this one
      if (folder !== prefix && !folder.startsWith(`${prefix}-`)) continue;
      let entries: string[];
      try {
        entries = await fsp.readdir(path.join(root, folder));
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const sessionId = entry.slice(0, -'.jsonl'.length);
        if (options.skip?.has(sessionId)) continue;
        const file = path.join(root, folder, entry);
        try {
          const stats = await fsp.stat(file);
          if (!stats.isFile() || stats.size === 0) continue;
          // A session already found under another account was moved by a profile swap
          const known = found.get(sessionId);
          if (known && known.modifiedMs >= stats.mtimeMs) continue;

          const cwd = await readTranscriptCwd(file);
          if (!cwd || !belongsToProject(cwd, projectPath)) continue;
          if (options.skipUnder?.some((directory) => belongsToProject(cwd, directory))) continue;

          found.set(sessionId, { sessionId, configDir, cwd, file, size: stats.size, modifiedMs: stats.mtimeMs });
        } catch {
          // Removed or unreadable while the folder was being read
        }
      }
    }
  }

  return [...found.values()].sort((a, b) => b.modifiedMs - a.modifiedMs);
}
