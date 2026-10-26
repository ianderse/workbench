/**
 * Process trees of agent runs:
 * - pure parts: process-table parsing, tree walk, orphan selection (parent 1, known program, cwd in a task worktree)
 * - POSIX, real processes: killing an agent run (spawnTool with processGroup) takes its grandchildren with it,
 *   also one that started its own session
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import {
  collectTree,
  isInTaskWorktree,
  orphanCandidates,
  parseLsofCwd,
  parsePsTable,
  selectOrphans,
  taskWorktreeRoots,
  type ProcEntry,
} from '../process-tree';

vi.mock('../../cli-tool-manager', () => ({ getToolPathAsync: vi.fn() }));

const row = (pid: number, ppid: number, pgid: number, comm = 'node'): ProcEntry => ({ pid, ppid, pgid, comm });

describe('parsePsTable', () => {
  it('reads pid, ppid, pgid and the base name of the command (macOS paths with spaces included)', () => {
    const table = parsePsTable(
      '  10     1    10 /usr/local/bin/node\n 11 10 10 /Applications/Some App/helper\nnot a row\n 12 11 12 vitest\n'
    );
    expect(table).toEqual([row(10, 1, 10, 'node'), row(11, 10, 10, 'helper'), row(12, 11, 12, 'vitest')]);
  });
});

describe('collectTree', () => {
  it('finds descendants through any depth and members of the root group, never 0, 1 or the app', () => {
    const table = [
      row(100, 1, 100),
      row(101, 100, 100),
      row(102, 101, 102), // started its own group
      row(103, 102, 102),
      row(104, 1, 100), // group member whose parent died
      row(200, 1, 200), // unrelated
      row(process.pid, 100, 100),
    ];
    expect(collectTree(table, 100).sort()).toEqual([100, 101, 102, 103, 104]);
  });
});

describe('orphan selection', () => {
  const roots = taskWorktreeRoots(['/work/app']);

  it('only matches inside the task worktrees of a project', () => {
    expect(isInTaskWorktree('/work/app/.workbench/worktrees/tasks/001-x', roots)).toBe(true);
    expect(isInTaskWorktree('/work/app/.workbench/worktrees/tasks/001-x/src', roots)).toBe(true);
    expect(isInTaskWorktree('/work/app/.workbench/worktrees/tasks', roots)).toBe(false);
    expect(isInTaskWorktree('/work/app/.workbench/worktrees/tasks-other/x', roots)).toBe(false);
    expect(isInTaskWorktree('/work/app', roots)).toBe(false);
    expect(isInTaskWorktree('/work/other/.workbench/worktrees/tasks/001', roots)).toBe(false);
  });

  it('candidates have parent 1 and a program agent tools start', () => {
    const table = [
      row(10, 1, 10, 'node'),
      row(11, 1, 11, 'python3.12'),
      row(12, 1, 12, 'pytest'),
      row(13, 5, 13, 'node'), // has a living parent
      row(14, 1, 14, 'sshd'), // not an agent tool
      row(15, 1, 15, 'vitest'),
    ];
    expect(orphanCandidates(table).map((e) => e.pid)).toEqual([10, 11, 12, 15]);
  });

  it('selects candidates by working directory only', () => {
    const candidates = [row(10, 1, 10), row(11, 1, 11), row(12, 1, 12)];
    const cwds = new Map([
      [10, '/work/app/.workbench/worktrees/tasks/001-x'],
      [11, '/work/app'],
      // 12: lsof failed
    ]);
    expect(selectOrphans(candidates, cwds, roots).map((e) => e.pid)).toEqual([10]);
  });

  it('parses lsof -Fn output', () => {
    expect(parseLsofCwd('p10\nn/a b\np11\nn/c\n')).toEqual(new Map([[10, '/a b'], [11, '/c']]));
  });
});

const posixIt = process.platform === 'win32' ? it.skip : it;

describe('killing an agent run takes its process tree with it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-tree-'));
  const pids: number[] = [];
  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  posixIt('ends grandchildren, also one in a session of its own', async () => {
    const { spawnTool, killRuntimeProcess } = await import('../runtime-exec');
    const script = path.join(dir, 'agent.js');
    writeFileSync(
      script,
      [
        "const { spawn } = require('child_process');",
        "const sleeper = ['-e', 'setInterval(() => {}, 1000)'];",
        "const same = spawn(process.execPath, sleeper, { stdio: 'ignore' });",
        "const own = spawn(process.execPath, sleeper, { stdio: 'ignore', detached: true });",
        'console.log(JSON.stringify([same.pid, own.pid]));',
        'setInterval(() => {}, 1000);',
      ].join('\n')
    );
    const child = spawnTool('claude', [script], { command: process.execPath, stdio: 'pipe', processGroup: true });
    const [same, own] = await new Promise<number[]>((resolve) => {
      child.stdout?.once('data', (data: Buffer) => resolve(JSON.parse(data.toString())));
    });
    pids.push(child.pid as number, same, own);
    expect(alive(same) && alive(own)).toBe(true);

    const exited = new Promise((resolve) => child.once('exit', resolve));
    killRuntimeProcess(child, { timeoutMs: 1500 });
    await exited;
    for (let i = 0; i < 80 && (alive(same) || alive(own)); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(same)).toBe(false);
    expect(alive(own)).toBe(false);
  }, 20_000);
});
