import { beforeEach, expect, it, vi } from 'vitest';
import type { Project, Task } from '../../../shared/types';
import type { AutoMergeInput } from '../autonomous-git';
const mocks = vi.hoisted(() => ({ tasks: [] as Task[], project: {} as Project, merge: vi.fn(), push: vi.fn(), notify: vi.fn() }));
vi.mock('../../project-store', () => ({ projectStore: { getProject: () => mocks.project, getTasks: () => mocks.tasks, invalidateTasksCache: vi.fn() } }));
vi.mock('../../agent-backend/settings', () => ({ getAgentBackendSettings: () => ({ kind: 'omp' }) }));
vi.mock('../../task-state-manager', () => ({ taskStateManager: { handleUiEvent: vi.fn(), getCurrentState: () => 'auto_merged' } }));
vi.mock('../../services/task-queue', () => ({ taskQueue: { request: vi.fn() } }));
vi.mock('../../queue-grooming', () => ({ groomQueueAfterMerge: vi.fn(async () => {}) }));
vi.mock('../../worktree-paths', () => ({ findTaskWorktree: () => '/tmp/merge-progress-worktree' }));
vi.mock('../../utils/base-branch', () => ({ resolveDefaultBaseBranch: async () => 'main' }));
vi.mock('../../claude-code/task-log', () => ({ TaskLogWriter: class { add() {} saveNow() {} } }));
vi.mock('../../ipc-handlers/task/plan-file-utils', () => ({
  updateTaskMetadataFields: (file: string, fields: Record<string, unknown>) => {
    const task = mocks.tasks.find(t => file.endsWith(`/${t.specId}/task_metadata.json`));
    if (task) {
      task.metadata = { ...task.metadata, ...fields };
      for (const [key, value] of Object.entries(fields)) if (value === undefined) delete (task.metadata as Record<string, unknown>)[key];
    }
  }, persistPlanStatusAndReasonSync: vi.fn(), getPlanPath: () => '/tmp/progress-plan.json',
}));
vi.mock('../autonomous-git', () => ({ autoMergeIntoTarget: mocks.merge, pushBranch: mocks.push }));
import { configureAutonomous, markInterruptedAutoMerges, maybeAutoMerge } from '../autonomous-service';

const task = (id = '001-progress'): Task => ({ id, specId: id, projectId: 'p', title: 'Merge fixture', status: 'human_review', reviewReason: 'completed', metadata: {}, claudeRun: { reviewVerdict: { status: 'passed' } } } as Task);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.project = { id: 'p', path: '/tmp/progress-project', autoBuildPath: '.workbench', settings: { autonomous: true, autonomousTarget: 'main', mainBranch: 'main' } } as Project;
  mocks.tasks = [task()];
  mocks.push.mockResolvedValue({ pushed: true });
  mocks.merge.mockResolvedValue({ success: true, sha: 'a'.repeat(40) });
  configureAutonomous(mocks.notify);
});

it('publishes resolving, verifying and pushing, then replaces progress with a durable merge receipt', async () => {
  const t = mocks.tasks[0];
  mocks.merge.mockImplementationOnce(async (input: AutoMergeInput) => {
    expect(t.metadata?.autoMergeProgress).toMatchObject({ phase: 'merging', targetBranch: 'main' });
    input.onProgress?.('resolving', 4);
    expect(t.metadata?.autoMergeProgress).toMatchObject({ phase: 'resolving', conflictCount: 4 });
    markInterruptedAutoMerges(mocks.project);
    expect(t.metadata?.autoMergeProgress?.phase).toBe('resolving');
    input.onProgress?.('verifying');
    expect(t.metadata?.autoMergeProgress).toMatchObject({ phase: 'verifying' });
    expect(t.metadata?.autoMergeProgress?.conflictCount).toBeUndefined();
    return { success: true, sha: 'a'.repeat(40) };
  });
  mocks.push.mockImplementationOnce(async () => {
    expect(t.metadata?.autoMergeProgress?.phase).toBe('pushing');
    expect(t.metadata?.autoMerge).toBeUndefined();
    return { pushed: true };
  });
  await maybeAutoMerge(mocks.project, t);
  expect(t.metadata?.autoMergeProgress).toBeUndefined();
  expect(t.metadata?.autoMerge).toMatchObject({ sha: 'a'.repeat(40), branch: 'main', pushed: true });
  expect(mocks.notify).toHaveBeenCalledWith('p');
});

it('shows a second merge queued while the first owns the project merge slot', async () => {
  let finish!: (value: unknown) => void;
  mocks.merge.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const [first] = mocks.tasks;
  const second = task('002-waiting'); mocks.tasks.push(second);
  const one = maybeAutoMerge(mocks.project, first);
  await vi.waitFor(() => expect(first.metadata?.autoMergeProgress?.phase).toBe('merging'));
  const two = maybeAutoMerge(mocks.project, second);
  expect(second.metadata?.autoMergeProgress?.phase).toBe('queued');
  expect(mocks.merge).toHaveBeenCalledTimes(1);
  finish({ success: true, sha: 'a'.repeat(40) });
  await Promise.all([one, two]);
  expect(second.metadata?.autoMergeProgress).toBeUndefined();
  expect(second.metadata?.autoMerge?.branch).toBe('main');
});

it('clears the spinner on a blocked merge and records unexpected failures visibly', async () => {
  const t = mocks.tasks[0];
  mocks.merge.mockResolvedValueOnce({ success: false, kind: 'conflicts', message: 'Could not preserve both routes' });
  await maybeAutoMerge(mocks.project, t);
  expect(t.metadata?.autoMergeProgress).toBeUndefined();
  expect(t.metadata?.autoMergeBlocked).toMatchObject({ reason: 'conflicts', message: expect.stringContaining('both routes') });
  const other = task('002-error'); mocks.tasks.push(other);
  mocks.merge.mockRejectedValueOnce(new Error('Git exited unexpectedly'));
  await maybeAutoMerge(mocks.project, other);
  expect(other.metadata?.autoMergeProgress).toBeUndefined();
  expect(other.metadata?.autoMergeBlocked?.message).toContain('Git exited unexpectedly');
});

it('marks saved activity interrupted after restart without resurrecting a completed merge', () => {
  const t = mocks.tasks[0];
  t.metadata!.autoMergeProgress = { phase: 'resolving', targetBranch: 'main', conflictCount: 4, at: '2026-10-27T20:40:46Z', startedAt: '2026-10-27T20:40:45Z' };
  markInterruptedAutoMerges(mocks.project);
  expect(t.metadata?.autoMergeProgress).toMatchObject({ phase: 'interrupted', startedAt: '2026-10-27T20:40:45Z' });
  const done = task('002-already-merged');
  done.metadata = { autoMergeProgress: { ...t.metadata!.autoMergeProgress!, phase: 'pushing', at: '2026-10-27T20:40:46Z' }, autoMerge: { branch: 'main', sha: 'b'.repeat(40), at: '2026-10-27T20:41:00Z' } };
  mocks.tasks.push(done);
  markInterruptedAutoMerges(mocks.project);
  expect(done.metadata?.autoMergeProgress).toBeUndefined();
  expect(done.metadata?.autoMerge?.sha).toBe('b'.repeat(40));
});
