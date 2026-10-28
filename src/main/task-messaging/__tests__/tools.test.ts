import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project, Task, TaskStatus } from '../../../shared/types';
import { taskSessionName } from '../../../shared/utils/task-messaging';
import { configureTaskMessaging, registerLiveRun, resetTaskMessagingForTests, takeInbox } from '../broker';
import { PARALLEL_TASKS_RESULT_MAX_CHARS, runTaskRunTool } from '../tools';

let root: string;
let tasks: Task[];

function task(specId: string, status: TaskStatus, metadata: Task['metadata'] = {}): Task {
  return { id: specId, specId, projectId: 'p1', title: `Title ${specId}`, description: '', status, subtasks: [], logs: [], metadata, createdAt: new Date(), updatedAt: new Date() };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'tools-'));
  const project = { id: 'p1', name: 'P', path: root, autoBuildPath: '.workbench', settings: { mainBranch: 'main' } } as unknown as Project;
  tasks = [task('001-me', 'in_progress'), task('002-other', 'in_progress', { baseBranch: 'develop' }), task('003-done', 'done'), task('004-backlog', 'backlog')];
  configureTaskMessaging({ getProject: () => project, getTasks: () => tasks });
  mkdirSync(path.join(root, '.workbench'), { recursive: true });
  writeFileSync(path.join(root, '.workbench', 'changelog.jsonl'), JSON.stringify({ at: '2026-10-01T00:00:00Z', task: '002-other', event: 'state', status: 'in_progress', files: ['src/a.ts'] }));
});

afterEach(() => {
  resetTaskMessagingForTests();
  rmSync(root, { recursive: true, force: true });
});

const context = { projectId: 'p1', specId: '001-me' };

describe('task run tools', () => {
  it('message_task sends from the calling task and answers in plain words', async () => {
    expect(await runTaskRunTool(context, 'message_task', { task: '002', message: 'heads up' })).toMatch(/^queued: 002-other/);
    const [message] = await takeInbox('p1', '002-other');
    expect(message.from).toEqual({ kind: 'task', specId: '001-me', title: 'Title 001-me', sessionName: taskSessionName('p1', '001-me') });
    expect(await runTaskRunTool(context, 'message_task', { task: '003-done', message: 'x' })).toMatch(/^not sent: 003-done is done/);
    expect(await runTaskRunTool(context, 'message_task', { message: 'x' })).toMatch(/^not sent/);
  });

  it('list_parallel_tasks shows the other unmerged tasks with session, status, files and whether they run', async () => {
    registerLiveRun({ projectId: 'p1', specId: '002-other', sessionName: 'x', send: () => false });
    const listed = await runTaskRunTool(context, 'list_parallel_tasks', {}) as { tasks: Array<Record<string, unknown>> };
    expect(listed.tasks).toEqual([{
      task: '002-other',
      title: 'Title 002-other',
      status: 'In Progress',
      session: taskSessionName('p1', '002-other'),
      runningNow: true,
      baseBranch: 'develop',
      files: ['src/a.ts'],
    }]);
  });

  it('refuses unknown tools', async () => {
    await expect(runTaskRunTool(context, 'create_task', {})).rejects.toThrow('Unknown tool');
  });

  it('filters changed files using the default changelog path when autoBuildPath is unset', async () => {
    const project = { id: 'p1', name: 'P', path: root } as Project;
    configureTaskMessaging({ getProject: () => project, getTasks: () => tasks });
    const listed = await runTaskRunTool(context, 'list_parallel_tasks', { file: 'src/a.ts' });
    expect(listed).toMatchObject({ total: 1, tasks: [{ task: '002-other', files: ['src/a.ts'] }] });
  });

  it('filters exact paths and task text, prioritizes dependencies and overlaps, and pages without losing task IDs', async () => {
    tasks = [task('001-me', 'in_progress', { dependsOnTaskIds: ['dependency'] }),
      ...Array.from({ length: 30 }, (_, i) => task(`queued-${i}`, 'queue')),
      task('active', 'in_progress'), task('overlap', 'human_review'), task('dependency', 'human_review')];
    tasks[tasks.length - 1].id = 'dependency-internal-id';
    writeFileSync(path.join(root, '.workbench', 'changelog.jsonl'), [
      { at: '2026-10-01T00:00:00Z', task: '001-me', event: 'state', files: ['src/shared.ts'] },
      { at: '2026-10-01T00:00:00Z', task: 'overlap', event: 'state', files: ['src/shared.ts', 'src/shared.tsx'] },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    type Page = { tasks: { task: string }[]; total: number; hasMore: boolean; nextOffset?: number };
    const first = await runTaskRunTool(context, 'list_parallel_tasks', { limit: 2 }) as Page;
    expect(first.tasks.map((t) => t.task)).toEqual(['dependency', 'overlap']);
    expect(first).toMatchObject({ total: 33, hasMore: true, nextOffset: 2 });
    const ids = first.tasks.map((t) => t.task);
    let page = first;
    while (page.hasMore) {
      page = await runTaskRunTool(context, 'list_parallel_tasks', { offset: page.nextOffset, limit: 20 }) as Page;
      ids.push(...page.tasks.map((t) => t.task));
    }
    expect(ids).toHaveLength(33);
    expect(new Set(ids).size).toBe(33);
    expect(ids[2]).toBe('active');
    const filtered = await runTaskRunTool(context, 'list_parallel_tasks', { file: 'src/shared.ts', task: 'OVERLAP' }) as Page;
    expect(filtered).toMatchObject({ total: 1, hasMore: false, tasks: [{ task: 'overlap' }] });
    const absent = await runTaskRunTool(context, 'list_parallel_tasks', { file: 'shared.ts' }) as Page;
    expect(absent.total).toBe(0);
  });

  it('caps pretty serialized results with large escaped fields and diffs, keeping exact IDs and file paths', async () => {
    tasks = [task('001-me', 'in_progress'), ...Array.from({ length: 30 }, (_, i) => ({
      ...task(`other-${i}`, 'in_progress', { baseBranch: '\\"'.repeat(1_000) }), title: '\\"'.repeat(20_000),
    }))];
    const files = Array.from({ length: 100 }, (_, i) => `src/${i}-${'long'.repeat(50)}.ts`);
    writeFileSync(path.join(root, '.workbench', 'changelog.jsonl'), tasks.slice(1).map((t) => JSON.stringify({
      at: '2026-10-01T00:00:00Z', task: t.specId, event: 'state', files,
    })).join('\n'));
    const page = await runTaskRunTool(context, 'list_parallel_tasks', { limit: 20 }) as {
      tasks: { task: string; files: string[]; moreFiles: number; baseBranch?: string; baseBranchOmitted?: boolean }[]; hasMore: boolean; nextOffset: number;
    };
    expect(JSON.stringify(page, null, 2).length).toBeLessThanOrEqual(PARALLEL_TASKS_RESULT_MAX_CHARS);
    expect(page.tasks.length).toBeGreaterThan(0);
    expect(page.tasks.length).toBeLessThan(20);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(page.tasks.length);
    for (const row of page.tasks) {
      expect(tasks.some((t) => t.specId === row.task)).toBe(true);
      expect(row.moreFiles + row.files.length).toBe(files.length);
      expect(row.baseBranch).toBeUndefined();
      expect(row.baseBranchOmitted).toBe(true);
      for (const file of row.files) expect(files).toContain(file);
    }
  });

  it('advances the cursor past oversized exact task IDs instead of repeating an empty page', async () => {
    tasks = [task('001-me', 'in_progress', { dependsOnTaskIds: ['huge-id'] }),
      { ...task('oversized'.repeat(2_000), 'in_progress'), id: 'huge-id' }, task('normal', 'queue')];
    const first = await runTaskRunTool(context, 'list_parallel_tasks', { limit: 1 }) as {
      tasks: unknown[]; hasMore: boolean; nextOffset: number; oversizedTasksOmitted: number;
    };
    expect(JSON.stringify(first, null, 2).length).toBeLessThanOrEqual(PARALLEL_TASKS_RESULT_MAX_CHARS);
    expect(first).toMatchObject({ tasks: [], hasMore: true, nextOffset: 1, oversizedTasksOmitted: 1 });
    const next = await runTaskRunTool(context, 'list_parallel_tasks', { offset: first.nextOffset }) as { tasks: { task: string }[]; hasMore: boolean };
    expect(next.tasks.map((t) => t.task)).toEqual(['normal']);
    expect(next.hasMore).toBe(false);
  });
});
