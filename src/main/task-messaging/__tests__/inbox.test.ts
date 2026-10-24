/**
 * The inbox file: a change never writes an empty inbox over messages it could not read, and a file
 * that is not valid JSON is kept aside instead of being overwritten
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readInbox, TASK_INBOX_FILE, updateInbox } from '../inbox';
import type { TaskMessage } from '../types';

let specDir: string;
const message = (id: string) => ({ id, text: `message ${id}`, status: 'queued' }) as unknown as TaskMessage;

beforeEach(() => {
  specDir = mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
});
afterEach(() => rmSync(specDir, { recursive: true, force: true }));

describe('inbox', () => {
  it('does not write over an inbox it could not read', async () => {
    // A path that can't be read as a file (as a locked or busy file can't)
    mkdirSync(path.join(specDir, TASK_INBOX_FILE));
    await expect(updateInbox(specDir, (messages) => [...messages, message('b')])).rejects.toThrow();
    expect(await readInbox(specDir)).toEqual([]);
  });

  it('keeps a corrupt inbox aside and starts a new one', async () => {
    writeFileSync(path.join(specDir, TASK_INBOX_FILE), '{"version":1,"messages":[{"id":"a"');
    await updateInbox(specDir, (messages) => [...messages, message('b')]);
    expect((await readInbox(specDir)).map((m) => m.id)).toEqual(['b']);
    const aside = readdirSync(specDir).find((name) => name.startsWith(`${TASK_INBOX_FILE}.corrupt-`));
    expect(aside && readFileSync(path.join(specDir, aside), 'utf-8')).toContain('"id":"a"');
    expect(existsSync(path.join(specDir, TASK_INBOX_FILE))).toBe(true);
  });
});
