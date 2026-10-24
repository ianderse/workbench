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

async function load(file: string): Promise<TaskMessage[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as Partial<InboxFile>;
    return Array.isArray(parsed?.messages) ? parsed.messages.filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string') : [];
  } catch {
    return [];
  }
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
  return load(file);
}

/**
 * Change the inbox: `mutate` gets its messages and changes them in place (or returns a new list).
 * Queued right away, so calls made one after another apply in that order.
 */
export function updateInbox(specDir: string, mutate: (messages: TaskMessage[]) => TaskMessage[] | void): Promise<TaskMessage[]> {
  const file = inboxFile(specDir);
  const previous = writes.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const messages = await load(file);
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
