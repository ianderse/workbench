/**
 * Writing memories in Claude Code's own auto-memory format, so everything the app writes is read,
 * maintained and listed by `/memory` exactly like a memory Claude wrote itself.
 *
 * The format was taken from a memory Claude Code actually wrote, not from a guess: a topic file per
 * memory with `name`, `description` and a `metadata` block, plus one line per memory in `MEMORY.md`,
 * which is the index loaded at the start of every session.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { getCompengDir, getMemoryIndexPath } from './paths';

/**
 * What the index says while it holds no memories. It is a comment, so it costs the session nothing,
 * and it keeps the file present so the `@` import of it from CLAUDE.md always resolves.
 */
export const MEMORY_INDEX_STUB =
  '<!-- Claude Code adds one line per memory here, and reads them at the start of every session. -->\n';

/** A memory to write: the rule itself plus what the index line says about it */
export interface MemoryDraft {
  /** kebab-case slug, used as the filename and the `name` field */
  name: string;
  /** One line, used for recall and as the index line's hook */
  description: string;
  /** The memory's own type, as Claude Code's four kinds */
  type: 'user' | 'feedback' | 'project' | 'reference';
  /** Title for the index line */
  title: string;
  /** The rule as an imperative, with its reasoning */
  body: string;
}

/**
 * How many memories the index may hold.
 *
 * Only the first 200 lines or 25KB of `MEMORY.md` are loaded, and everything past that is dropped
 * silently, so the cap is well inside the limit rather than near it. A small index also reads better.
 */
export const MAX_MEMORIES = 25;

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'memory';

/** One topic file in the format Claude Code writes */
function renderMemory(draft: MemoryDraft, modified: string): string {
  return [
    '---',
    `name: ${draft.name}`,
    `description: ${JSON.stringify(draft.description)}`,
    'metadata:',
    '  node_type: memory',
    `  type: ${draft.type}`,
    `  modified: ${modified}`,
    '---',
    '',
    draft.body.trim(),
    '',
  ].join('\n');
}

/** What an index line points at, which is how two indexes are told to hold the same memory */
const indexTarget = (line: string): string | null => /\]\(([^)]+)\)/.exec(line)?.[1] ?? null;

/**
 * Union of two memory indexes.
 *
 * `MEMORY.md` is the user's own index file: Claude Code writes lines into it, but the user may also
 * have put headings or notes of their own there, so the first index is kept exactly as it stands and
 * only the lines of the second one that name a memory the first does not mention are appended.
 * Duplicate guidance is something a later session folds together on its own. The placeholder comment
 * goes as soon as there is a real line, since it only ever stood in for an empty index.
 */
export function mergeIndexes(into: string, from: string): string {
  const isStub = (line: string) => line.trim() === MEMORY_INDEX_STUB.trim();

  const kept = into.split('\n').filter((line) => !isStub(line));
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  // A line that links to no file is keyed by its own text, so hand-written prose is not duplicated
  const known = new Set(kept.map((line) => indexTarget(line) ?? line.trim()).filter((key) => key !== ''));

  const added: string[] = [];
  for (const line of from.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || isStub(line)) continue;
    const key = indexTarget(trimmed) ?? trimmed;
    if (known.has(key)) continue;
    known.add(key);
    added.push(trimmed);
  }

  const lines = [...kept, ...added];
  return lines.length === 0 ? MEMORY_INDEX_STUB : `${lines.join('\n')}\n`;
}

/** Existing index lines, keyed by the file they link to, so rewriting keeps what is already there */
async function readIndexEntries(projectPath: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  try {
    const content = await readFile(getMemoryIndexPath(projectPath), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('-')) continue;
      const target = indexTarget(trimmed);
      if (target) entries.set(target, trimmed);
    }
  } catch {
    // No index yet
  }
  return entries;
}

/**
 * Write memories into the project's memory directory and add them to the index.
 *
 * Existing memories are kept: a draft whose slug is already there is skipped rather than overwritten,
 * because a memory on disk may have been edited by hand or refined by a later session, and this
 * writer only ever adds. The index is merged for the same reason, rather than rebuilt from the lines
 * this writer can parse: anything else the user wrote into it stays. Returns the names written.
 */
export async function writeMemories(projectPath: string, drafts: MemoryDraft[]): Promise<string[]> {
  const dir = getCompengDir(projectPath);
  await mkdir(dir, { recursive: true });

  const indexPath = getMemoryIndexPath(projectPath);
  const existingIndex = await readIfPresent(indexPath);
  const entries = await readIndexEntries(projectPath);
  const modified = new Date().toISOString();
  const written: string[] = [];
  const added: string[] = [];

  for (const draft of drafts) {
    if (entries.size >= MAX_MEMORIES) break;
    const name = slug(draft.name);
    const filename = `${name}.md`;
    if (entries.has(filename)) continue;

    await writeFile(path.join(dir, filename), renderMemory({ ...draft, name }, modified), 'utf-8');
    const line = `- [${draft.title}](${filename}) — ${draft.description}`;
    entries.set(filename, line);
    added.push(line);
    written.push(name);
  }

  await writeFile(indexPath, mergeIndexes(existingIndex ?? '', added.join('\n')), 'utf-8');
  return written;
}

/** How many memories the project holds, by its index */
export async function countMemories(projectPath: string): Promise<number> {
  return (await readIndexEntries(projectPath)).size;
}

/**
 * What the project already remembers, one line per memory, for a prompt that has to be told not to
 * write them again. The index line is what says it: it names the memory and states its rule.
 */
export async function listMemories(projectPath: string): Promise<string[]> {
  return [...(await readIndexEntries(projectPath)).values()].map((line) => line.replace(/^[-*]\s*/, ''));
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf-8');
  } catch {
    return null;
  }
}
