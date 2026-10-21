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
 */
export function belongsToProject(cwd: string, projectPath: string): boolean {
  const session = path.resolve(cwd);
  const project = path.resolve(projectPath);
  if (session === project) return true;
  return session.startsWith(project.endsWith(path.sep) ? project : project + path.sep);
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
      // Skip the harness's own injections and the empty turns around tool use
      if (trimmed === '' || trimmed.startsWith('<') || trimmed.startsWith('Caveat:')) continue;
      const clipped = trimmed.slice(0, Math.max(0, maxChars - used));
      turns.push(clipped);
      used += clipped.length;
    }
  } finally {
    reader.close();
  }
  return turns;
}
