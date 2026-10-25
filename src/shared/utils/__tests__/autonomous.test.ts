import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import type { Task, TaskStatus } from '../../types';
import { taskMachine } from '../../state-machines/task-machine';
import { mapStateToLegacy } from '../../state-machines';
import {
  ANY_TARGET_BRANCH,
  DEFAULT_AUTONOMOUS_BRANCH,
  activeAutoMerge,
  decideAutoMerge,
  dependentTargetHint,
  findAutoMergedDependents,
  getExplicitBaseBranch,
  getAutonomousTargetBranch,
  isDependencySatisfied,
  resolveAutonomousConfig,
} from '../autonomous';
import { getPromotableQueuedTasks, getUnmetDependencyIds } from '../../../main/services/task-queue';

const NOW = Date.parse('2026-10-05T10:00:00.000Z');

function makeTask(id: string, status: TaskStatus, metadata: Task['metadata'] = {}): Task {
  return {
    id,
    specId: id,
    projectId: 'p1',
    title: id,
    description: '',
    status,
    subtasks: [],
    logs: [],
    metadata,
    createdAt: new Date(NOW - 1000),
    updatedAt: new Date(NOW - 1000),
  } as Task;
}

const merged = (branch = 'workbench/auto') => ({ autoMerge: { sha: 'abc123', branch, at: new Date(NOW).toISOString() } });
const on = resolveAutonomousConfig({ autonomous: true });

describe('resolveAutonomousConfig', () => {
  it('is off by default and defaults to the integration branch with push on', () => {
    expect(resolveAutonomousConfig(undefined)).toEqual({
      enabled: false,
      target: 'integration',
      integrationBranch: DEFAULT_AUTONOMOUS_BRANCH,
      push: true,
    });
  });

  it('keeps a valid custom branch and falls back for an invalid one', () => {
    expect(resolveAutonomousConfig({ autonomous: true, autonomousBranch: ' team/auto ' }).integrationBranch).toBe('team/auto');
    expect(resolveAutonomousConfig({ autonomous: true, autonomousBranch: 'bad name' }).integrationBranch).toBe(DEFAULT_AUTONOMOUS_BRANCH);
    expect(resolveAutonomousConfig({ autonomous: true, autonomousBranch: 'a..b' }).integrationBranch).toBe(DEFAULT_AUTONOMOUS_BRANCH);
  });

  it('picks the target branch', () => {
    expect(getAutonomousTargetBranch(on, 'main')).toBe('workbench/auto');
    expect(getAutonomousTargetBranch(resolveAutonomousConfig({ autonomous: true, autonomousTarget: 'main' }), 'develop')).toBe('develop');
    expect(getAutonomousTargetBranch(resolveAutonomousConfig({ autonomous: false }), 'main')).toBeUndefined();
  });
});

describe('decideAutoMerge', () => {
  const passed = { status: 'human_review', reviewReason: 'completed', verdictStatus: 'passed' } as const;

  it('merges a completed task that passed AI review', () => {
    expect(decideAutoMerge(on, passed)).toEqual({ eligible: true });
  });

  it('never merges when the mode is off', () => {
    expect(decideAutoMerge(resolveAutonomousConfig({ autonomous: false }), passed).eligible).toBe(false);
  });

  it('never merges a failed verdict', () => {
    expect(decideAutoMerge(on, { ...passed, verdictStatus: 'failed' })).toMatchObject({ eligible: false, reason: 'the AI review failed' });
  });

  it('requires an AI review: no verdict (validation off) is not merged', () => {
    expect(decideAutoMerge(on, { ...passed, verdictStatus: undefined }).eligible).toBe(false);
  });

  it('never merges a stopped task or one that is not a finished run', () => {
    expect(decideAutoMerge(on, { ...passed, reviewReason: 'stopped' }).eligible).toBe(false);
    expect(decideAutoMerge(on, { ...passed, stopped: true }).eligible).toBe(false);
    expect(decideAutoMerge(on, { ...passed, reviewReason: 'qa_rejected' }).eligible).toBe(false);
    expect(decideAutoMerge(on, { ...passed, reviewReason: 'errors' }).eligible).toBe(false);
    expect(decideAutoMerge(on, { ...passed, status: 'in_progress' }).eligible).toBe(false);
  });

  it('does not merge a task twice', () => {
    expect(decideAutoMerge(on, { ...passed, alreadyMerged: true }).eligible).toBe(false);
  });
});

describe('dependencies in autonomous mode', () => {
  it('done always satisfies; an auto-merge satisfies only toward the branch the dependent branches from', () => {
    const dep = makeTask('dep', 'human_review', merged());
    expect(isDependencySatisfied(makeTask('d', 'done'), undefined)).toBe(true);
    expect(isDependencySatisfied(dep, undefined)).toBe(false);
    expect(isDependencySatisfied(dep, 'workbench/auto')).toBe(true);
    expect(isDependencySatisfied(dep, 'main')).toBe(false);
    expect(isDependencySatisfied(dep, ANY_TARGET_BRANCH)).toBe(true);
  });

  it('a reverted merge no longer satisfies', () => {
    const dep = makeTask('dep', 'human_review', { autoMerge: { ...merged().autoMerge, revertedAt: 'x' } });
    expect(activeAutoMerge(dep)).toBeUndefined();
    expect(isDependencySatisfied(dep, 'workbench/auto')).toBe(false);
  });

  it('the queue gate waits for human-review tasks unless they were auto-merged into the dependent\'s branch', () => {
    const waiting = makeTask('b', 'queue', { dependsOnTaskIds: ['a'] });
    const reviewed = makeTask('a', 'human_review');
    const autoMerged = makeTask('a', 'human_review', merged());

    expect(getUnmetDependencyIds(waiting, [waiting, reviewed], 'workbench/auto')).toEqual(['a']);
    expect(getUnmetDependencyIds(waiting, [waiting, autoMerged], 'workbench/auto')).toEqual([]);
    // Autonomous mode off: the same task still blocks
    expect(getUnmetDependencyIds(waiting, [waiting, autoMerged])).toEqual(['a']);
    // Merged into another branch than the dependent starts from
    expect(getUnmetDependencyIds(waiting, [waiting, autoMerged], 'main')).toEqual(['a']);
  });

  it('a task that failed AI review (not merged) keeps its dependents waiting', () => {
    const failed = makeTask('a', 'human_review');
    const waiting = makeTask('b', 'queue', { dependsOnTaskIds: ['a'] });
    expect(getPromotableQueuedTasks([failed, waiting], NOW, [], () => 'workbench/auto')).toEqual([]);
  });

  it('promotes the dependent of an auto-merged task', () => {
    const a = makeTask('a', 'human_review', merged());
    const b = makeTask('b', 'queue', { dependsOnTaskIds: ['a'] });
    expect(getPromotableQueuedTasks([a, b], NOW, [], () => 'workbench/auto').map((t) => t.id)).toEqual(['b']);
  });

  it('lists later auto-merged dependents of a task, transitively', () => {
    const a = makeTask('a', 'human_review', merged());
    const b = makeTask('b', 'human_review', { ...merged(), dependsOnTaskIds: ['a'] });
    const c = makeTask('c', 'human_review', { ...merged(), dependsOnTaskIds: ['b'] });
    const d = makeTask('d', 'queue', { dependsOnTaskIds: ['a'] });
    expect(findAutoMergedDependents(a, [a, b, c, d]).map((t) => t.id).sort()).toEqual(['b', 'c']);
  });
});

describe('review reason transitions (state machine)', () => {
  const start = (state: string) =>
    createActor(taskMachine, { snapshot: taskMachine.resolveState({ value: state, context: {} }) as never }).start();

  it('QA_PASSED reaches human review as completed, then AUTO_MERGED makes it auto_merged', () => {
    const actor = start('qa_review');
    actor.send({ type: 'QA_PASSED', iteration: 1, testsRun: {} });
    expect(actor.getSnapshot().value).toBe('human_review');
    expect(actor.getSnapshot().context.reviewReason).toBe('completed');

    actor.send({ type: 'AUTO_MERGED' });
    expect(actor.getSnapshot().value).toBe('auto_merged');
    expect(actor.getSnapshot().context.reviewReason).toBe('auto_merged');
    expect(mapStateToLegacy('auto_merged', actor.getSnapshot().context.reviewReason)).toEqual({
      status: 'human_review',
      reviewReason: 'auto_merged',
    });
  });

  it('Done from auto_merged goes straight to done (the work is merged already)', () => {
    const actor = start('human_review');
    actor.send({ type: 'AUTO_MERGED' });
    actor.send({ type: 'MARK_DONE' });
    expect(actor.getSnapshot().value).toBe('done');
  });

  it('a failed review is never auto-merged by the machine and AUTO_MERGED is ignored outside human review', () => {
    const failed = start('qa_review');
    failed.send({ type: 'QA_FAILED', iteration: 1, issueCount: 1, issues: ['x'] });
    expect(failed.getSnapshot().context.reviewReason).toBe('qa_rejected');
    const running = start('coding');
    running.send({ type: 'AUTO_MERGED' });
    expect(running.getSnapshot().value).toBe('coding');
  });

  it('a revert makes it an ordinary completed task again; request changes restarts work', () => {
    const reverted = start('human_review');
    reverted.send({ type: 'AUTO_MERGED' });
    reverted.send({ type: 'AUTO_MERGE_REVERTED' });
    expect(reverted.getSnapshot().value).toBe('human_review');
    expect(reverted.getSnapshot().context.reviewReason).toBe('completed');

    const resumed = start('human_review');
    resumed.send({ type: 'AUTO_MERGED' });
    resumed.send({ type: 'USER_RESUMED' });
    expect(resumed.getSnapshot().value).toBe('coding');
  });
});

describe('getExplicitBaseBranch', () => {
  const chosen = (baseBranch: string, extra: Task['metadata'] = {}) => makeTask('t', 'queue', { baseBranch, baseBranchChosen: true, ...extra });

  it('honours a chosen branch that is not the project default or the integration branch', () => {
    expect(getExplicitBaseBranch(on, chosen('feature/x'), ['main'])).toBe('feature/x');
    expect(getExplicitBaseBranch(on, chosen('origin/feature/x'), ['main'])).toBe('feature/x');
  });

  it('ignores the project default, the integration branch and unflagged tasks', () => {
    expect(getExplicitBaseBranch(on, chosen('main'), ['main'])).toBeUndefined();
    expect(getExplicitBaseBranch(on, chosen('origin/main'), [undefined, 'main'])).toBeUndefined();
    expect(getExplicitBaseBranch(on, chosen('workbench/auto'), ['main'])).toBeUndefined();
    // Old tasks (no flag) keep following the target even when they name a branch
    expect(getExplicitBaseBranch(on, makeTask('t', 'queue', { baseBranch: 'feature/x' }), ['main'])).toBeUndefined();
    expect(getExplicitBaseBranch(on, makeTask('t', 'queue', {}), ['main'])).toBeUndefined();
  });

  it('applies in both targets, but not while autonomous mode is off or without a worktree', () => {
    const toMain = resolveAutonomousConfig({ autonomous: true, autonomousTarget: 'main' });
    expect(getExplicitBaseBranch(toMain, chosen('feature/x'), ['main'])).toBe('feature/x');
    expect(getExplicitBaseBranch(resolveAutonomousConfig({ autonomous: false }), chosen('feature/x'), ['main'])).toBeUndefined();
    expect(getExplicitBaseBranch(on, chosen('feature/x', { useWorktree: false }), ['main'])).toBeUndefined();
  });
});

describe('dependencies across a chosen base branch', () => {
  const intoFeature = makeTask('a', 'human_review', { baseBranch: 'feature/x', baseBranchChosen: true, ...merged('feature/x') });
  const intoMain = makeTask('a', 'human_review', merged('main'));

  it('a dependency merged into a feature branch satisfies dependents on that branch only', () => {
    expect(isDependencySatisfied(intoFeature, 'feature/x')).toBe(true);
    expect(isDependencySatisfied(intoFeature, 'main')).toBe(false);
    expect(isDependencySatisfied(intoFeature, 'workbench/auto')).toBe(false);
    // Dependents that follow the shared target (hint ANY) are not released by it
    expect(isDependencySatisfied(intoFeature, ANY_TARGET_BRANCH)).toBe(false);
    expect(isDependencySatisfied(intoMain, ANY_TARGET_BRANCH)).toBe(true);
  });

  it('the dependent hint is its chosen branch, else any shared target', () => {
    expect(dependentTargetHint(makeTask('b', 'queue', { baseBranch: 'feature/x', baseBranchChosen: true }))).toBe('feature/x');
    expect(dependentTargetHint(makeTask('b', 'queue', { baseBranch: 'main' }))).toBe(ANY_TARGET_BRANCH);
  });

  it('the queue gate releases a dependent on the same feature branch', () => {
    const onFeature = makeTask('b', 'queue', { dependsOnTaskIds: ['a'], baseBranch: 'feature/x', baseBranchChosen: true });
    expect(getUnmetDependencyIds(onFeature, [onFeature, intoFeature], 'feature/x')).toEqual([]);
    const onMain = makeTask('c', 'queue', { dependsOnTaskIds: ['a'] });
    expect(getUnmetDependencyIds(onMain, [onMain, intoFeature], ANY_TARGET_BRANCH)).toEqual(['a']);
  });
});
