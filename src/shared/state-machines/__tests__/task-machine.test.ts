import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { taskMachine, type TaskEvent } from '../task-machine';

/**
 * Helper to run a sequence of events and get the final state
 */
function runEvents(events: TaskEvent[], initialState?: string) {
  const actor = initialState
    ? createActor(taskMachine, {
        snapshot: taskMachine.resolveState({ value: initialState, context: {} })
      })
    : createActor(taskMachine);
  actor.start();

  for (const event of events) {
    actor.send(event);
  }

  const snapshot = actor.getSnapshot();
  actor.stop();
  return snapshot;
}

describe('taskMachine', () => {
  describe('initial state', () => {
    it('should start in backlog state', () => {
      const actor = createActor(taskMachine);
      actor.start();
      expect(actor.getSnapshot().value).toBe('backlog');
      actor.stop();
    });

    it('should have empty context initially', () => {
      const actor = createActor(taskMachine);
      actor.start();
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.reviewReason).toBeUndefined();
      expect(snapshot.context.error).toBeUndefined();
      actor.stop();
    });
  });

  describe('happy path: backlog → planning → coding → qa_review → human_review → done', () => {
    it('should transition through the standard workflow', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'QA_STARTED', iteration: 1, maxIterations: 3 },
        { type: 'QA_PASSED', iteration: 1, testsRun: {} },
        { type: 'MARK_DONE' }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('done');
      expect(snapshot.context.reviewReason).toBe('completed');
    });

    it('should set reviewReason to completed when QA passes', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'QA_STARTED', iteration: 1, maxIterations: 3 },
        { type: 'QA_PASSED', iteration: 1, testsRun: {} }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('human_review');
      expect(snapshot.context.reviewReason).toBe('completed');
    });
  });

  describe('Claude Code validation', () => {
    it('goes to human_review with qa_rejected when validation fails', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'QA_STARTED', iteration: 1, maxIterations: 1 },
        { type: 'QA_FAILED', iteration: 1, issueCount: 2, issues: ['issue1', 'issue2'] }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('human_review');
      expect(snapshot.context.reviewReason).toBe('qa_rejected');
    });

    it('accepts a validation result that arrives in coding (validated in an earlier run)', () => {
      const failed = runEvents([
        { type: 'USER_RESUMED' },
        { type: 'QA_FAILED', iteration: 1, issueCount: 1, issues: ['issue'] }
      ], 'human_review');
      expect(failed.value).toBe('human_review');
      expect(failed.context.reviewReason).toBe('qa_rejected');
    });

    it('applies requested changes: human_review → coding → qa_review → human_review', () => {
      const snapshot = runEvents([
        { type: 'USER_RESUMED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Applying requested changes' },
        { type: 'QA_STARTED', iteration: 1, maxIterations: 1 },
        { type: 'QA_PASSED', iteration: 1, testsRun: {} }
      ], 'human_review');
      expect(snapshot.value).toBe('human_review');
      expect(snapshot.context.reviewReason).toBe('completed');
    });

    it('goes to error when triage fails with CODING_FAILED during planning', () => {
      const snapshot = runEvents([
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_FAILED', subtaskId: '', error: 'boom', attemptCount: 1 }
      ]);
      expect(snapshot.value).toBe('error');
      expect(snapshot.context.error).toBe('boom');
    });
  });

  describe('error states', () => {
    it('should transition to error on PLANNING_FAILED', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'PLANNING_FAILED', error: 'Test error', recoverable: false }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('error');
      expect(snapshot.context.reviewReason).toBe('errors');
      expect(snapshot.context.error).toBe('Test error');
    });

    it('should transition to error on CODING_FAILED', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'CODING_FAILED', subtaskId: 'sub1', error: 'Coding error', attemptCount: 3 }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('error');
      expect(snapshot.context.reviewReason).toBe('errors');
      expect(snapshot.context.error).toBe('Coding error');
    });

    it('should transition to error on QA_MAX_ITERATIONS from qa_review', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'QA_STARTED', iteration: 1, maxIterations: 3 },
        { type: 'QA_MAX_ITERATIONS', iteration: 3, maxIterations: 3 }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('error');
      expect(snapshot.context.reviewReason).toBe('errors');
    });

    it('should transition to error on QA_AGENT_ERROR', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'QA_STARTED', iteration: 1, maxIterations: 3 },
        { type: 'QA_AGENT_ERROR', iteration: 1, consecutiveErrors: 3 }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('error');
      expect(snapshot.context.reviewReason).toBe('errors');
    });

    it('should allow recovery from error via USER_RESUMED', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'PLANNING_FAILED', error: 'Test error', recoverable: true },
        { type: 'USER_RESUMED' }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('coding');
      expect(snapshot.context.reviewReason).toBeUndefined();
      expect(snapshot.context.error).toBeUndefined();
    });

    it('should allow MARK_DONE from error state', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'PLANNING_FAILED', error: 'Test error', recoverable: false },
        { type: 'MARK_DONE' }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('done');
    });
  });

  describe('user stop/resume', () => {
    it('should go to backlog when stopped during planning with no plan', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'USER_STOPPED', hasPlan: false }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('backlog');
    });

    it('should go to human_review when stopped during planning with plan', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'USER_STOPPED', hasPlan: true }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('human_review');
      expect(snapshot.context.reviewReason).toBe('stopped');
    });

    it('should go to human_review when stopped during coding', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'USER_STOPPED' }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('human_review');
      expect(snapshot.context.reviewReason).toBe('stopped');
    });

    it('should go to human_review when stopped during qa_review', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'QA_STARTED', iteration: 1, maxIterations: 3 },
        { type: 'USER_STOPPED' }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('human_review');
      expect(snapshot.context.reviewReason).toBe('stopped');
    });

    it('should resume from human_review to coding', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'USER_STOPPED' },
        { type: 'USER_RESUMED' }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('coding');
      expect(snapshot.context.reviewReason).toBeUndefined();
    });
  });

  describe('moving back to Planning (MOVED_TO_BACKLOG)', () => {
    it.each(['qa_review', 'human_review', 'error', 'queued'])('goes from %s to backlog and clears the review reason', (state) => {
      const snapshot = runEvents([{ type: 'MOVED_TO_BACKLOG' }], state);
      expect(snapshot.value).toBe('backlog');
      expect(snapshot.context.reviewReason).toBeUndefined();
    });

    it('moves a stopped task in human review back to backlog', () => {
      const snapshot = runEvents([
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'USER_STOPPED' },
        { type: 'MOVED_TO_BACKLOG' }
      ]);
      expect(snapshot.value).toBe('backlog');
      expect(snapshot.context.reviewReason).toBeUndefined();
    });

    it('is ignored once the task is done', () => {
      expect(runEvents([{ type: 'MOVED_TO_BACKLOG' }], 'done').value).toBe('done');
    });
  });

  describe('PR flow', () => {
    it('should transition to creating_pr on CREATE_PR', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'QA_STARTED', iteration: 1, maxIterations: 3 },
        { type: 'QA_PASSED', iteration: 1, testsRun: {} },
        { type: 'CREATE_PR' }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('creating_pr');
    });

    it('should transition to pr_created on PR_CREATED', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'QA_STARTED', iteration: 1, maxIterations: 3 },
        { type: 'QA_PASSED', iteration: 1, testsRun: {} },
        { type: 'CREATE_PR' },
        { type: 'PR_CREATED', prUrl: 'https://github.com/test/pr/1' }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('pr_created');
    });

    it('should transition from pr_created to done on MARK_DONE', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'QA_STARTED', iteration: 1, maxIterations: 3 },
        { type: 'QA_PASSED', iteration: 1, testsRun: {} },
        { type: 'CREATE_PR' },
        { type: 'PR_CREATED', prUrl: 'https://github.com/test/pr/1' },
        { type: 'MARK_DONE' }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('done');
    });

    it('lets a task with an unmerged PR go back to Planning or continue like Human Review', () => {
      const prCreated: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'QA_STARTED', iteration: 1, maxIterations: 3 },
        { type: 'QA_PASSED', iteration: 1, testsRun: {} },
        { type: 'CREATE_PR' },
        { type: 'PR_CREATED', prUrl: 'https://github.com/test/pr/1' }
      ];
      expect(runEvents([...prCreated, { type: 'MOVED_TO_BACKLOG' }]).value).toBe('backlog');
      expect(runEvents([...prCreated, { type: 'USER_RESUMED' }]).value).toBe('coding');
      expect(runEvents([...prCreated, { type: 'PLANNING_STARTED' }]).value).toBe('planning');
    });
  });

  describe('unexpected process exit', () => {
    it('should go to error on unexpected process exit during planning', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'PROCESS_EXITED', exitCode: 1, unexpected: true }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('error');
      expect(snapshot.context.reviewReason).toBe('errors');
    });

    it('should go to error on unexpected process exit during coding', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'PROCESS_EXITED', exitCode: 1, unexpected: true }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('error');
      expect(snapshot.context.reviewReason).toBe('errors');
    });

    it('should NOT go to error on expected process exit (unexpected=false)', () => {
      // Expected exit shouldn't trigger error state - the guard should fail
      const snapshot = runEvents(
        [{ type: 'PROCESS_EXITED', exitCode: 0, unexpected: false }],
        'coding'
      );

      // Should stay in coding since guard fails
      expect(snapshot.value).toBe('coding');
    });
  });

  describe('fallback transitions', () => {
    it('should allow CODING_STARTED from backlog (resumed task)', () => {
      const events: TaskEvent[] = [
        { type: 'CODING_STARTED', subtaskId: 'sub1', subtaskDescription: 'Test' }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('coding');
    });

    it('should allow CODING_STARTED from planning (Claude Code starts implementing)', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: 'sub1', subtaskDescription: 'Test' }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('coding');
    });

    it('should allow ALL_SUBTASKS_DONE from planning (fast task)', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'ALL_SUBTASKS_DONE', totalCount: 1 }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('qa_review');
    });

    it('should allow QA_STARTED from planning (missed coding events)', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'QA_STARTED', iteration: 1, maxIterations: 3 }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('qa_review');
    });

    it('should allow QA_PASSED from planning (entire build completed quickly)', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'QA_PASSED', iteration: 1, testsRun: {} }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('human_review');
      expect(snapshot.context.reviewReason).toBe('completed');
    });

    it('should allow QA_PASSED from coding (missed QA_STARTED)', () => {
      const events: TaskEvent[] = [
        { type: 'PLANNING_STARTED' },
        { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: 'Implementing' },
        { type: 'QA_PASSED', iteration: 1, testsRun: {} }
      ];

      const snapshot = runEvents(events);
      expect(snapshot.value).toBe('human_review');
      expect(snapshot.context.reviewReason).toBe('completed');
    });
  });

  describe('rate-limit hold (RATE_LIMIT_HOLD)', () => {
    const hold: TaskEvent = {
      type: 'RATE_LIMIT_HOLD',
      resetAt: '2026-10-05T16:30:00.000Z',
      message: "You've hit your session limit · resets 8:30pm (Asia/Yerevan)",
      phase: 'coding'
    };

    it.each(['planning', 'coding', 'qa_review', 'qa_fixing'])('moves %s to queued', (initialState) => {
      const snapshot = runEvents([hold], initialState);
      expect(snapshot.value).toBe('queued');
      expect(snapshot.context.reviewReason).toBeUndefined();
    });

    it('is ignored outside active states', () => {
      expect(runEvents([hold], 'backlog').value).toBe('backlog');
      expect(runEvents([hold], 'human_review').value).toBe('human_review');
    });

    it('ignores unexpected PROCESS_EXITED while queued', () => {
      const snapshot = runEvents([hold, { type: 'PROCESS_EXITED', exitCode: 1, unexpected: true }], 'coding');
      expect(snapshot.value).toBe('queued');
    });

    it('resumes from queued via PLANNING_STARTED then follows the build', () => {
      const snapshot = runEvents(
        [
          hold,
          { type: 'PLANNING_STARTED' },
          { type: 'CODING_STARTED', subtaskId: '', subtaskDescription: '' }
        ],
        'coding'
      );
      expect(snapshot.value).toBe('coding');
    });

    it('can be resumed directly into coding and stopped back to backlog/human_review', () => {
      expect(runEvents([hold, { type: 'USER_RESUMED' }], 'coding').value).toBe('coding');
      expect(runEvents([hold, { type: 'USER_STOPPED', hasPlan: false }], 'planning').value).toBe('backlog');
      const stopped = runEvents([hold, { type: 'USER_STOPPED', hasPlan: true }], 'coding');
      expect(stopped.value).toBe('human_review');
      expect(stopped.context.reviewReason).toBe('stopped');
    });
  });

  describe('state restoration from task', () => {
    it('should restore to correct state from existing task status', () => {
      // Test restoring to different states
      const testCases = [
        { initialState: 'backlog', expectedState: 'backlog' },
        { initialState: 'planning', expectedState: 'planning' },
        { initialState: 'coding', expectedState: 'coding' },
        { initialState: 'qa_review', expectedState: 'qa_review' },
        { initialState: 'qa_fixing', expectedState: 'qa_fixing' },
        { initialState: 'queued', expectedState: 'queued' },
        { initialState: 'human_review', expectedState: 'human_review' },
        { initialState: 'error', expectedState: 'error' },
        { initialState: 'pr_created', expectedState: 'pr_created' },
        { initialState: 'done', expectedState: 'done' }
      ];

      for (const { initialState, expectedState } of testCases) {
        const actor = createActor(taskMachine, {
          snapshot: taskMachine.resolveState({ value: initialState, context: {} })
        });
        actor.start();
        expect(actor.getSnapshot().value).toBe(expectedState);
        actor.stop();
      }
    });
  });
});
