/**
 * Finding and reading the Claude Code session transcripts that belong to a project, so the first
 * memory index can be built from what the user already said in past sessions.
 *
 * Transcripts live under `<config dir>/projects/<encoded cwd>/<session>.jsonl`. The folder name is an
 * undocumented encoding of the session's working directory, so it is never inverted: each transcript
 * records its own `cwd`, and that is what attributes it to a project. A project's sessions are spread
 * across the default config dir and every Claude account's own, so all of them are searched.
 */

import { createReadStream } from 'fs';
import { readdir, stat } from 'fs/promises';
import path from 'path';
import { createInterface } from 'readline';
import { claudeConfigDirs } from '../claude-profile/profile-config-dirs';
import { PHASE_PROMPT_OPENING_LIST } from '../claude-code/phase-prompts';
import { isWindows } from '../platform';
import { isClaudeHomeInWsl } from '../platform/claude-home';
import { toHostPath } from '../platform/shell-runtime';
import { windowsPathKey } from '../platform/wsl-paths';

/** One transcript that belongs to the project */
export interface ProjectTranscript {
  file: string;
  /** The working directory the session recorded, which is what attributed it here */
  cwd: string;
  modifiedMs: number;
}

/** How many lines to read before giving up on finding the session's cwd */
const CWD_PROBE_LINES = 40;

/**
 * Whether the session's `cwd` places it in this project: the project itself or anywhere inside it,
 * matched on path-component boundaries so `my-repo-old` is not `my-repo`.
 *
 * A session started in a parent directory is deliberately not claimed. It may have touched this
 * project, but it may equally have been about a sibling, and a preference learned from one project
 * and written into another is worse than one missed. Task worktrees live inside the project, so they
 * are covered by the inside case.
 *
 * The two paths can arrive in different namespaces: a transcript records the directory as the OS
 * Claude Code runs on saw it, which in WSL is a Linux path (`/mnt/c/Users/me/app`), while the paths
 * Workbench stores and passes in are host paths (`C:\Users\me\app`). Comparing them as they come
 * would match nothing, so the session's side is brought into the host namespace first. The host in
 * that case is Windows, which is also whose separator decides where one component ends.
 *
 * Windows also reaches one folder through several spellings — any case, and either of the two UNC
 * prefixes for the distribution's own files, since a project the user added from Explorer is stored
 * as `\\wsl$\Ubuntu\home\me\app` while `toHostPath()` renders every session's cwd as
 * `\\wsl.localhost\Ubuntu\home\me\app`. Both sides therefore go through `windowsPathKey()`
 * (platform/wsl-paths.ts), the same key `worktreePathKey()` (worktree/runtime-worktrees.ts) compares
 * worktrees by and for the same reason: a spelling rejected here silently costs that session its
 * spending in Metrics and its turns in the backfill, and a project added under the alias would lose
 * every session it has. POSIX paths are compared as they are, since there two folders really can
 * differ in case alone.
 */
export function belongsToProject(cwd: string, projectPath: string): boolean {
  const inWsl = isClaudeHomeInWsl();
  // Host paths are Windows paths both when the app runs on Windows and whenever Claude Code's home
  // is a WSL one, which only Windows has
  const windowsPaths = inWsl || isWindows();
  const paths = windowsPaths ? path.win32 : path;
  const key = (p: string): string => (windowsPaths ? windowsPathKey(p) : paths.resolve(p));
  const session = key(inWsl ? toHostPath(cwd) : cwd);
  const project = key(projectPath);
  if (session === project) return true;
  return session.startsWith(project.endsWith(paths.sep) ? project : project + paths.sep);
}

/** The `cwd` the transcript recorded, read from its opening lines */
export async function readTranscriptCwd(file: string): Promise<string | null> {
  const reader = createInterface({ input: createReadStream(file, { encoding: 'utf-8' }), crlfDelay: Infinity });
  try {
    let seen = 0;
    for await (const line of reader) {
      if (++seen > CWD_PROBE_LINES) break;
      if (!line.includes('"cwd"')) continue;
      try {
        const parsed = JSON.parse(line) as { cwd?: unknown };
        if (typeof parsed.cwd === 'string' && parsed.cwd !== '') return parsed.cwd;
      } catch {
        // A partial or non-JSON line says nothing about the session
      }
    }
    return null;
  } finally {
    reader.close();
  }
}

/**
 * The project's transcripts, newest first.
 *
 * A transcript with no recorded `cwd` is dropped rather than guessed at, and the current session's
 * own transcript is excluded when its id is known, since it is the conversation asking for this.
 */
export async function findProjectTranscripts(
  projectPath: string,
  options: { maxSessions?: number; excludeSessionId?: string } = {}
): Promise<ProjectTranscript[]> {
  const found: ProjectTranscript[] = [];

  for (const configDir of claudeConfigDirs()) {
    const root = path.join(configDir, 'projects');
    let encodedDirs: string[];
    try {
      encodedDirs = await readdir(root);
    } catch {
      continue;
    }

    for (const encoded of encodedDirs) {
      let files: string[];
      try {
        files = (await readdir(path.join(root, encoded))).filter((name) => name.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of files) {
        if (options.excludeSessionId && name === `${options.excludeSessionId}.jsonl`) continue;
        const file = path.join(root, encoded, name);
        try {
          const info = await stat(file);
          if (!info.isFile() || info.size === 0) continue;
          const cwd = await readTranscriptCwd(file);
          if (cwd === null || !belongsToProject(cwd, projectPath)) continue;
          found.push({ file, cwd, modifiedMs: info.mtimeMs });
        } catch {
          // An unreadable transcript is skipped
        }
      }
    }
  }

  found.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return options.maxSessions ? found.slice(0, options.maxSessions) : found;
}

/** What the user typed in one session, oldest turn first */
export async function readUserTurns(file: string, maxChars: number): Promise<string[]> {
  const reader = createInterface({ input: createReadStream(file, { encoding: 'utf-8' }), crlfDelay: Infinity });
  const turns: string[] = [];
  let used = 0;
  try {
    for await (const line of reader) {
      if (used >= maxChars) break;
      if (!line.includes('"user"')) continue;
      let parsed: {
        type?: unknown;
        isMeta?: unknown;
        message?: { role?: unknown; content?: unknown };
      };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.type !== 'user' || parsed.isMeta === true) continue;
      const content = parsed.message?.content;
      // A turn the person typed is text; a tool result is the same role and is not one
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((block): block is { type: string; text: string } => {
                  const b = block as { type?: unknown; text?: unknown };
                  return b.type === 'text' && typeof b.text === 'string';
                })
                .map((block) => block.text)
                .join('\n')
            : '';
      const trimmed = text.trim();
      // Skip the harness's own injections, Workbench's own phase prompts, and the empty turns
      // around tool use
      if (trimmed === '' || trimmed.startsWith('<') || trimmed.startsWith('Caveat:')) continue;
      if (PHASE_PROMPT_OPENING_LIST.some((opening) => trimmed.startsWith(opening))) continue;
      const clipped = trimmed.slice(0, Math.max(0, maxChars - used));
      turns.push(clipped);
      used += clipped.length;
    }
  } finally {
    reader.close();
  }
  return turns;
}
