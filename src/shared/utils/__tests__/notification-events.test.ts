import { describe, expect, it, vi } from 'vitest';
import {
  DecisionBatcher,
  QueueEmptyTracker,
  countWaiting,
  decisionNeededContent,
  hasActiveWork,
  needsAttentionContent,
  queueEmptyContent,
  taskDoneContent,
  taskMergedContent,
  type Scheduler,
} from '../notification-events';

/** A manual scheduler: timers run when the test advances time */
function fakeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: Scheduler = {
    set: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    scheduler,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

const task = { id: 't1', specId: '001-a', title: 'Add login' };

describe('notification text and routes', () => {
  it('describes a merge with its branch and opens the task', () => {
    const c = taskMergedContent('p1', task, 'workbench/auto');
    expect(c).toMatchObject({ kind: 'task-complete', title: 'Task merged', route: { projectId: 'p1', taskId: 't1' } });
    expect(c.body).toContain('workbench/auto');
    expect(taskDoneContent('p1', task).title).toBe('Task merged');
  });

  it('falls back to the spec id without a title', () => {
    expect(taskMergedContent('p1', { ...task, title: '' }, 'main').body).toContain('001-a');
  });

  it('maps needs-attention reasons to the failed switch', () => {
    const blocked = needsAttentionContent('p1', task, 'auto-merge-blocked', 'conflicts');
    expect(blocked.kind).toBe('task-failed');
    expect(blocked.body).toContain('conflicts');
    expect(needsAttentionContent('p1', task, 'resume-failed').body).toContain('could not be resumed');
    expect(needsAttentionContent('p1', task, 'error').route.taskId).toBe('t1');
  });

  it('opens the ticket for one decision and the board for several', () => {
    expect(decisionNeededContent('p1', [])).toBeNull();
    const one = decisionNeededContent('p1', [{ taskId: 'a', title: 'Pick a DB' }])!;
    expect(one.title).toBe('Decision needed: Pick a DB');
    expect(one.route).toEqual({ projectId: 'p1', taskId: 'a' });
    const many = decisionNeededContent('p1', ['a', 'b', 'c', 'd', 'e'].map((id) => ({ taskId: id, title: `T${id}` })))!;
    expect(many.title).toBe('Decisions needed: 5 tickets');
    expect(many.body).toContain('and 2 more');
    expect(many.route).toEqual({ projectId: 'p1' });
  });

  it('writes the all-done summary and opens the board', () => {
    const c = queueEmptyContent('p1', 'Shop', 3, 2);
    expect(c.title).toBe('All tasks finished in Shop');
    expect(c.body).toBe('3 merged, 2 waiting for review or decision');
    expect(c.route.taskId).toBeUndefined();
  });
});

describe('board counts', () => {
  it('sees active work in the queue, In Progress and AI review only', () => {
    expect(hasActiveWork([{ status: 'queue' }, { status: 'done' }] as never)).toBe(true);
    expect(hasActiveWork([{ status: 'ai_review' }] as never)).toBe(true);
    expect(hasActiveWork([{ status: 'human_review' }, { status: 'backlog' }, { status: 'error' }] as never)).toBe(false);
    expect(hasActiveWork([{ status: 'queue', metadata: { archivedAt: 'x' } }] as never)).toBe(false);
  });

  it('counts review and open decision tickets as waiting, not auto-merged ones', () => {
    const tasks = [
      { status: 'human_review', reviewReason: 'completed' },
      { status: 'human_review', reviewReason: 'auto_merged' },
      { status: 'backlog', metadata: { followUpFrom: { needsDecision: true } } },
      { status: 'backlog', metadata: { followUpFrom: { needsDecision: true }, decision: { outcome: 'rejected' } } },
      { status: 'done' },
    ];
    expect(countWaiting(tasks as never)).toBe(2);
  });
});

describe('QueueEmptyTracker', () => {
  function setup(idle = true) {
    const fake = fakeScheduler();
    const finished = vi.fn();
    const state = { idle };
    const tracker = new QueueEmptyTracker(finished, () => state.idle, 5000, fake.scheduler);
    return { fake, finished, tracker, state };
  }

  it('does not fire for a board that was never active (app start)', () => {
    const { fake, finished, tracker } = setup();
    tracker.observe('p1', false);
    fake.advance(60_000);
    expect(finished).not.toHaveBeenCalled();
  });

  it('fires once after active work ends and the debounce passes, with the merge count', () => {
    const { fake, finished, tracker } = setup();
    tracker.observe('p1', true);
    tracker.recordMerge('p1');
    tracker.recordMerge('p1');
    tracker.observe('p1', false);
    fake.advance(4000);
    expect(finished).not.toHaveBeenCalled();
    fake.advance(1500);
    expect(finished).toHaveBeenCalledExactlyOnceWith('p1', 2);
    tracker.observe('p1', false);
    fake.advance(10_000);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('is cancelled when a task moves from the queue to In Progress within the debounce', () => {
    const { fake, finished, tracker } = setup();
    tracker.observe('p1', true);
    tracker.observe('p1', false);
    fake.advance(2000);
    tracker.observe('p1', true);
    expect(fake.pending()).toBe(0);
    fake.advance(10_000);
    expect(finished).not.toHaveBeenCalled();
  });

  it('checks again when the timer fires', () => {
    const { fake, finished, tracker, state } = setup();
    tracker.observe('p1', true);
    tracker.observe('p1', false);
    state.idle = false;
    fake.advance(6000);
    expect(finished).not.toHaveBeenCalled();
  });

  it('tracks projects separately', () => {
    const { fake, finished, tracker } = setup();
    tracker.observe('p1', true);
    tracker.observe('p2', false);
    tracker.observe('p1', false);
    fake.advance(6000);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished.mock.calls[0][0]).toBe('p1');
  });
});

describe('DecisionBatcher', () => {
  it('batches tickets created close together into one flush per project', () => {
    const fake = fakeScheduler();
    const flush = vi.fn();
    const batcher = new DecisionBatcher(flush, 2000, fake.scheduler);
    batcher.add('p1', [{ taskId: 'a', title: 'A' }]);
    batcher.add('p1', [{ taskId: 'b', title: 'B' }]);
    batcher.add('p2', [{ taskId: 'c', title: 'C' }]);
    batcher.add('p1', []);
    fake.advance(2100);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledWith('p1', [
      { taskId: 'a', title: 'A' },
      { taskId: 'b', title: 'B' },
    ]);
    batcher.add('p1', [{ taskId: 'd', title: 'D' }]);
    fake.advance(2100);
    expect(flush).toHaveBeenLastCalledWith('p1', [{ taskId: 'd', title: 'D' }]);
  });
});
