/**
 * A task's inbox: `<specDir>/task_inbox.json`, the messages sent to the task (queued, sent to its
 * running session, read). Writes are atomic (temp file + rename) and run one at a time per file,
 * in the order they were asked for.
 */
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import type { TaskMessage } from './types';

export const TASK_INBOX_FILE = 'task_inbox.json';
/** Read messages kept for the record; unread ones are always kept */
const KEEP_READ = 100;

interface InboxFile {
  version: 1;
  messages: TaskMessage[];
}

const writes = new Map<string, Promise<unknown>>();

function inboxFile(specDir: string): string {
  return path.join(specDir, TASK_INBOX_FILE);
}

/**
 * The inbox's messages. No file: none. A file that can't be read (a busy or locked file) throws,
 * so a change never writes an empty inbox over messages it could not see; one that is not valid
 * JSON is kept aside (`task_inbox.json.corrupt-<time>`) and counts as empty
 */
async function load(file: string, keepCorruptAside = false): Promise<TaskMessage[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: Partial<InboxFile>;
  try {
    parsed = JSON.parse(text) as Partial<InboxFile>;
  } catch {
    if (keepCorruptAside) await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined);
    return [];
  }
  return Array.isArray(parsed?.messages) ? parsed.messages.filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string') : [];
}

function prune(messages: TaskMessage[]): TaskMessage[] {
  const read = messages.filter((m) => m.status === 'read');
  if (read.length <= KEEP_READ) return messages;
  const drop = new Set(read.slice(0, read.length - KEEP_READ));
  return messages.filter((m) => !drop.has(m));
}

/** The inbox's messages, oldest first */
export async function readInbox(specDir: string): Promise<TaskMessage[]> {
  const file = inboxFile(specDir);
  await writes.get(file)?.catch(() => undefined);
  return load(file).catch(() => []);
}

/**
 * Change the inbox: `mutate` gets its messages and changes them in place (or returns a new list).
 * Queued right away, so calls made one after another apply in that order.
 */
export function updateInbox(specDir: string, mutate: (messages: TaskMessage[]) => TaskMessage[] | void): Promise<TaskMessage[]> {
  const file = inboxFile(specDir);
  const previous = writes.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const messages = await load(file, true);
    const updated = prune(mutate(messages) ?? messages);
    await mkdir(specDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, messages: updated } satisfies InboxFile, null, 2), 'utf-8');
    await rename(tmp, file);
    return updated;
  });
  writes.set(file, next);
  void next.finally(() => {
    if (writes.get(file) === next) writes.delete(file);
  }).catch(() => undefined);
  return next;
}
