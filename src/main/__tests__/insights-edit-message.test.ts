import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = vi.fn();

vi.mock('../insights/insights-executor', async () => {
  const { EventEmitter } = await import('events');
  class FakeExecutor extends EventEmitter {
    cancelSession() { return false; }
    execute(...args: unknown[]) { return execute(...args); }
  }
  return { InsightsExecutor: FakeExecutor };
});
vi.mock('../insights/config', () => ({ InsightsConfig: class { configure() {} } }));

import { insightsService as service } from '../insights-service';

let projectDir: string;
let pid: string;
let run = 0;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'insights-edit-'));
  pid = `project-${++run}`;
  execute.mockReset();
});
afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

function answer(text: string) {
  execute.mockResolvedValueOnce({ fullResponse: text, toolsUsed: [] });
}

describe('InsightsService.editMessage', () => {
  it('drops the chat after the edited message and sends the edit', async () => {
    answer('First reply');
    await service.sendMessage(pid, projectDir, 'first question');
    answer('Second reply');
    await service.sendMessage(pid, projectDir, 'second question');
    const firstId = service.loadSession(pid, projectDir)!.messages[0].id;

    answer('Reply to the edit');
    await service.editMessage(pid, projectDir, firstId, 'edited question');

    const session = service.loadSession(pid, projectDir)!;
    expect(session.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'edited question'],
      ['assistant', 'Reply to the edit'],
    ]);
    // The edited first message names the conversation now
    expect(session.title).toBe('edited question');
    // Claude sees the edited message as the latest one, without the dropped turns
    const [, , message, history] = execute.mock.calls.at(-1)!;
    expect(message).toBe('edited question');
    expect(history).toEqual([{ role: 'user', content: 'edited question' }]);
  });

  it('keeps a title the user gave', async () => {
    answer('Reply');
    await service.sendMessage(pid, projectDir, 'question');
    const session = service.loadSession(pid, projectDir)!;
    service.renameSession(projectDir, session.id, 'My chat');
    session.title = 'My chat';

    answer('Reply to the edit');
    await service.editMessage(pid, projectDir, session.messages[0].id, 'edited');

    expect(service.loadSession(pid, projectDir)!.title).toBe('My chat');
  });

  it('ignores an unknown message', async () => {
    answer('Reply');
    await service.sendMessage(pid, projectDir, 'question');

    await service.editMessage(pid, projectDir, 'msg-missing', 'edited');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.loadSession(pid, projectDir)!.messages).toHaveLength(2);
  });
});
