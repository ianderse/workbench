/**
 * Reading what an agent window's Claude Code session spent, from its transcript: the turns priced
 * per model give the days, and the totals Claude Code writes give the amount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  combineSpending,
  findSessionTranscript,
  latestTranscript,
  readTranscriptSpending,
} from '../claude-code/session-spending';

// The profile manager is not running in tests; only the config dirs passed in are searched
vi.mock('../claude-profile-manager', () => ({ getClaudeProfileManager: () => ({ getProfileConfigDirs: () => [] }) }));

/** Timestamp of a local hour on a local day, the way a transcript stores it */
const at = (day: string, hour: number): string => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, hour).toISOString();
};

const started = (day: string, hour: number): number => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, hour).getTime();
};

describe('session spending', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'session-spending-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A transcript under a config dir, in the folder Claude Code names after the session's cwd */
  const writeTranscript = (configDir: string, sessionId: string, lines: string[], cwd = '/home/user/project'): string => {
    const dir = path.join(root, configDir, 'projects', cwd.replace(/\//g, '-'));
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  };

  /** An assistant record: `outputTokens` on Claude Opus 5 costs $25 per million */
  const turn = (timestamp: string, outputTokens: number, requestId = `req-${timestamp}-${outputTokens}`) =>
    JSON.stringify({
      type: 'assistant',
      requestId,
      timestamp,
      message: { id: `msg-${requestId}`, model: 'claude-opus-5', usage: { output_tokens: outputTokens } },
    });
  const message = (timestamp: string, content: unknown = 'ok') =>
    JSON.stringify({ type: 'user', message: { content }, timestamp });
  const costState = (startTime: number, totalCostUSD: number) =>
    JSON.stringify({ type: 'cost-state', startTime, totalCostUSD, totalDuration: 1000 });

  const configDirs = (...dirs: string[]) => dirs.map((dir) => path.join(root, dir));
  const spendingOf = async (sessionId: string, dirs: string[], cwd?: string) => {
    const transcript = await findSessionTranscript(sessionId, dirs, cwd);
    return transcript ? readTranscriptSpending(transcript.file) : null;
  };
  const days = (spending: { byDay: Map<string, number> } | null) =>
    [...(spending?.byDay ?? [])].map(([day, costUsd]) => [day, Number(costUsd.toFixed(6))]);

  it('books every turn on the day it was spent, not on the day the session was last used', async () => {
    writeTranscript('.claude', 'abc', [
      turn(at('2026-10-19', 9), 10_000),
      // The session ran past midnight, and was picked up again two days later
      turn(at('2026-10-20', 1), 30_000),
      turn(at('2026-10-22', 15), 40_000),
    ]);

    const spending = await spendingOf('abc', configDirs('.claude'));

    expect(spending?.totalCostUsd).toBeCloseTo(2, 6);
    expect(days(spending)).toEqual([
      ['2026-10-19', 0.25],
      ['2026-10-20', 0.75],
      ['2026-10-22', 1],
    ]);
  });

  it('scales the days to the total Claude Code itself reported', async () => {
    writeTranscript('.claude', 'abc', [
      turn(at('2026-10-19', 9), 10_000),
      turn(at('2026-10-20', 9), 30_000),
      // Claude Code's own figure is higher: it also covers what the turns do not price
      costState(started('2026-10-19', 9), 2),
    ]);

    const spending = await spendingOf('abc', configDirs('.claude'));

    expect(spending?.totalCostUsd).toBe(2);
    expect(days(spending)).toEqual([
      ['2026-10-19', 0.5],
      ['2026-10-20', 1.5],
    ]);
  });

  it('keeps the earlier days of a resumed session on those days', async () => {
    writeTranscript('.claude', 'abc', [
      turn(at('2026-10-19', 9), 10_000),
      costState(started('2026-10-19', 9), 0.25),
      // Resumed two days later: the session's cost accounting is restored with it, so the total it
      // reports goes on climbing from what the first day cost instead of starting again at zero
      turn(at('2026-10-21', 9), 30_000),
      costState(started('2026-10-19', 9), 1),
    ]);

    const spending = await spendingOf('abc', configDirs('.claude'));

    expect(spending?.totalCostUsd).toBeCloseTo(1, 6);
    expect(days(spending)).toEqual([
      ['2026-10-19', 0.25],
      ['2026-10-21', 0.75],
    ]);
  });

  it('counts the total one process reported in two transcripts once, not once per transcript', async () => {
    // One Claude Code process worked on both conversations and wrote its own running total to each
    const process = started('2026-10-20', 9);
    writeTranscript('.claude', 'first', [turn(at('2026-10-20', 10), 10_000), costState(process, 80)]);
    writeTranscript('.claude', 'second', [turn(at('2026-10-21', 10), 10_000), costState(process, 100)]);

    const first = await spendingOf('first', configDirs('.claude'));
    const second = await spendingOf('second', configDirs('.claude'));
    const together = combineSpending([first!, second!]);

    // Each conversation on its own still reports what Claude Code reported in it
    expect(first?.totalCostUsd).toBe(80);
    expect(second?.totalCostUsd).toBe(100);
    // Together they are the one process's $100, not $180
    expect(together.totalCostUsd).toBe(100);
    expect(days(together)).toEqual([
      ['2026-10-20', 50],
      ['2026-10-21', 50],
    ]);
  });

  /**
   * The reconciliation is per set of transcripts that share a cost accounting, not per project.
   * Reconciling the project in one go let a session Claude Code could not price swallow another
   * session's priced turns: the money went missing from the total and was booked on days the
   * other session never ran on.
   */
  it('does not let one session\'s reported total swallow another session\'s priced turns', async () => {
    // Finished on a model with no published price, so its turns price to nothing and only Claude
    // Code's own figure says what it cost
    writeTranscript('.claude', 'unpriced', [
      JSON.stringify({
        type: 'assistant',
        requestId: 'req-unpriced',
        timestamp: at('2026-10-20', 10),
        message: { id: 'msg-unpriced', model: 'some-unpublished-model', usage: { output_tokens: 10_000 } },
      }),
      costState(started('2026-10-20', 9), 20),
    ]);
    // Still running on the next day: its turns are priced, and it has written no total yet
    writeTranscript('.claude', 'running', [turn(at('2026-10-21', 10), 200_000)]);

    const unpriced = await spendingOf('unpriced', configDirs('.claude'));
    const running = await spendingOf('running', configDirs('.claude'));
    const together = combineSpending([unpriced!, running!]);

    expect(unpriced?.totalCostUsd).toBe(20);
    expect(running?.totalCostUsd).toBeCloseTo(5, 6);
    // Both are counted, each on its own day: no accounting is shared, so neither caps the other
    expect(together.totalCostUsd).toBeCloseTo(25, 6);
    expect(days(together)).toEqual([
      ['2026-10-20', 20],
      ['2026-10-21', 5],
    ]);
  });

  it('keeps the totals of two transcripts apart when the process that wrote them is unknown', async () => {
    writeTranscript('.claude', 'first', [message(at('2026-10-20', 10)), costState(0, 2)]);
    writeTranscript('.claude', 'second', [message(at('2026-10-21', 10)), costState(0, 3)]);

    const first = await spendingOf('first', configDirs('.claude'));
    const second = await spendingOf('second', configDirs('.claude'));

    // Neither line says which process it belongs to, so neither total can stand in for the other
    expect(combineSpending([first!, second!]).totalCostUsd).toBe(5);
  });

  it('counts what the session spent since the last total it wrote', async () => {
    writeTranscript('.claude', 'abc', [
      turn(at('2026-10-20', 9), 40_000),
      costState(started('2026-10-20', 9), 1),
      // Two answers since the checkpoint: Claude Code writes its next total later
      turn(at('2026-10-20', 10), 10_000),
      turn(at('2026-10-20', 11), 10_000),
    ]);

    const spending = await spendingOf('abc', configDirs('.claude'));

    expect(spending?.totalCostUsd).toBeCloseTo(1.5, 6);
    expect(days(spending)).toEqual([['2026-10-20', 1.5]]);
  });

  it('counts a request once although the transcript repeats it per content block', async () => {
    writeTranscript('.claude', 'abc', [
      turn(at('2026-10-20', 9), 40_000, 'req-1'),
      turn(at('2026-10-20', 9), 40_000, 'req-1'),
      turn(at('2026-10-20', 9), 40_000, 'req-1'),
    ]);

    const spending = await spendingOf('abc', configDirs('.claude'));

    expect(spending?.totalCostUsd).toBeCloseTo(1, 6);
  });

  it('books a total it cannot price on the session\'s last day', async () => {
    writeTranscript('.claude', 'abc', [
      message(at('2026-10-20', 9)),
      // A tool result that read another JSON file brings its timestamps along
      message(at('2026-10-20', 10), [
        { type: 'tool_result', content: '{"timestamp":"2019-03-01T10:00:00.000Z","costUsd":3}' },
      ]),
      costState(started('2026-10-20', 9), 0.4),
    ]);

    const spending = await spendingOf('abc', configDirs('.claude'));

    expect(days(spending)).toEqual([['2026-10-20', 0.4]]);
  });

  it('finds the transcript under another profile after a swap', async () => {
    writeTranscript('.claude-profiles/work', 'abc', [
      turn(at('2026-10-20', 9), 30_000),
      costState(started('2026-10-20', 9), 0.75),
    ]);

    const spending = await spendingOf('abc', configDirs('.claude', '.claude-profiles/work'), '/home/user/project');

    expect(spending?.totalCostUsd).toBe(0.75);
  });

  it('finds a transcript whose folder does not match the session cwd it was started in', async () => {
    writeTranscript('.claude', 'abc', [costState(1, 0.1)], '/somewhere/else');

    const transcript = await findSessionTranscript('abc', configDirs('.claude'), '/home/user/project');

    expect(transcript?.file).toContain('-somewhere-else');
    expect(transcript?.size).toBeGreaterThan(0);
  });

  it('has no transcript for a session that never wrote one', async () => {
    expect(await findSessionTranscript('gone', configDirs('.claude'), '/home/user/project')).toBeNull();
  });

  it('skips lines that were still being written and sessions that never cost anything', async () => {
    writeTranscript('.claude', 'abc', [
      message(at('2026-10-20', 9)),
      '{"type":"cost-state","startTime":1,"totalCost',
      '{"type":"assistant","requestId":"r","message":{"usage":{"output_tokens',
      costState(started('2026-10-20', 9), 0),
    ]);

    const spending = await spendingOf('abc', configDirs('.claude'));

    expect(spending?.totalCostUsd).toBe(0);
    expect(spending?.byDay.size).toBe(0);
  });

  it('gives up what it read when the transcript cannot be read through', async () => {
    const spending = await readTranscriptSpending(path.join(root, 'no-such-file.jsonl'));

    expect(spending.totalCostUsd).toBe(0);
    expect(spending.byDay.size).toBe(0);
    expect(spending.runTotals.size).toBe(0);
  });

  describe('the session a restored window continues', () => {
    it('is the one written to last in the directory, over every account', async () => {
      writeTranscript('.claude', 'older', [turn(at('2026-10-19', 9), 10_000)]);
      const newest = writeTranscript('.claude-profiles/work', 'newer', [turn(at('2026-10-20', 9), 10_000)]);
      const { utimesSync } = await import('fs');
      utimesSync(newest, new Date(2026, 9, 20), new Date(2026, 9, 20));
      utimesSync(
        path.join(root, '.claude', 'projects', '-home-user-project', 'older.jsonl'),
        new Date(2026, 9, 19),
        new Date(2026, 9, 19)
      );

      const latest = await latestTranscript(configDirs('.claude', '.claude-profiles/work'), '/home/user/project');

      expect(latest?.sessionId).toBe('newer');
      expect(latest?.configDir).toBe(path.join(root, '.claude-profiles/work'));
    });

    it('is nothing when Claude Code never ran in the directory', async () => {
      writeTranscript('.claude', 'elsewhere', [turn(at('2026-10-19', 9), 10_000)], '/other/project');

      expect(await latestTranscript(configDirs('.claude'), '/home/user/project')).toBeNull();
    });
  });
});
