/**
 * Tests for AgentState - Queue Routing functionality
 *
 * Tests the profile assignment tracking and running tasks by profile features.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../app-logger', () => ({
  appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AgentState } from './agent-state';
import { appLog } from '../app-logger';

/**
 * The cases below that name no project are deliberate: the project is optional because callers
 * outside the agent module still have only a task id, and this state has to keep answering them
 * as long as they do. The project-aware cases live in their own block at the end.
 */
describe('AgentState - Queue Routing', () => {
  let state: AgentState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = new AgentState();
  });

  describe('getRunningTasksByProfile', () => {
    it('should return empty state when no processes running', () => {
      const result = state.getRunningTasksByProfile();

      expect(result.byProfile).toEqual({});
      expect(result.totalRunning).toBe(0);
    });

    it('should group tasks by profile', () => {
      // Mark tasks as running
      state.addRunning('task-1');
      state.addRunning('task-2');
      state.addRunning('task-3');

      // Assign profiles
      state.assignProfileToTask('task-1', 'profile-1', 'Profile 1', 'proactive');
      state.assignProfileToTask('task-2', 'profile-1', 'Profile 1', 'proactive');
      state.assignProfileToTask('task-3', 'profile-2', 'Profile 2', 'proactive');

      const result = state.getRunningTasksByProfile();

      expect(result.byProfile['profile-1']).toHaveLength(2);
      expect(result.byProfile['profile-2']).toHaveLength(1);
      expect(result.totalRunning).toBe(3);
    });

    it('finds the assignment of a run whose project was not known when it was stored', () => {
      // The project is the last and optional argument of `assignProfileToTask`, so an assignment
      // can be stored without one while the run itself knows its project. Reading the composite
      // key straight out of the map would miss that entry and report the run as `default`, which
      // is a profile nothing is rate-limit-tracked under.
      state.addRunning('001-add-login', 'project-1');
      state.assignProfileToTask('001-add-login', 'profile-1', 'Profile 1', 'proactive');

      expect(state.getRunningTasksByProfile().byProfile).toEqual({ 'profile-1': ['001-add-login'] });
    });

    it('should use default profile for unassigned tasks', () => {
      // Running task without profile assignment
      state.addRunning('task-1');

      const result = state.getRunningTasksByProfile();

      expect(result.byProfile['default']).toContain('task-1');
      expect(result.totalRunning).toBe(1);
    });
  });

  describe('assignProfileToTask', () => {
    it('should assign profile to task', () => {
      state.assignProfileToTask('task-1', 'profile-1', 'Test Profile', 'proactive');

      const assignment = state.getTaskProfileAssignment('task-1');

      expect(assignment).toBeDefined();
      expect(assignment?.profileId).toBe('profile-1');
      expect(assignment?.profileName).toBe('Test Profile');
      expect(assignment?.reason).toBe('proactive');
    });

    it('should preserve session ID when reassigning profile', () => {
      // Initial assignment
      state.assignProfileToTask('task-1', 'profile-1', 'Profile 1', 'proactive');
      state.updateTaskSession('task-1', 'session-abc');

      // Reassign to different profile
      state.assignProfileToTask('task-1', 'profile-2', 'Profile 2', 'reactive');

      const assignment = state.getTaskProfileAssignment('task-1');
      expect(assignment?.profileId).toBe('profile-2');
      expect(assignment?.sessionId).toBe('session-abc');
    });

    it('should support different assignment reasons', () => {
      state.assignProfileToTask('task-1', 'p1', 'P1', 'proactive');
      state.assignProfileToTask('task-2', 'p2', 'P2', 'reactive');
      state.assignProfileToTask('task-3', 'p3', 'P3', 'manual');

      expect(state.getTaskProfileAssignment('task-1')?.reason).toBe('proactive');
      expect(state.getTaskProfileAssignment('task-2')?.reason).toBe('reactive');
      expect(state.getTaskProfileAssignment('task-3')?.reason).toBe('manual');
    });
  });

  describe('getTaskProfileAssignment', () => {
    it('should return undefined for non-existent task', () => {
      const assignment = state.getTaskProfileAssignment('non-existent');
      expect(assignment).toBeUndefined();
    });
  });

  describe('updateTaskSession', () => {
    it('should update session ID for existing assignment', () => {
      state.assignProfileToTask('task-1', 'profile-1', 'Profile 1', 'proactive');
      state.updateTaskSession('task-1', 'session-123');

      const assignment = state.getTaskProfileAssignment('task-1');
      expect(assignment?.sessionId).toBe('session-123');
    });

    it('should create minimal assignment if none exists', () => {
      // Update session without prior assignment
      state.updateTaskSession('task-1', 'session-456');

      const assignment = state.getTaskProfileAssignment('task-1');
      expect(assignment).toBeDefined();
      expect(assignment?.sessionId).toBe('session-456');
      expect(assignment?.profileId).toBe('unknown');
    });

    it('should create assignment with provided profile info', () => {
      state.updateTaskSession('task-1', 'session-789', {
        profileId: 'my-profile',
        profileName: 'My Profile'
      });

      const assignment = state.getTaskProfileAssignment('task-1');
      expect(assignment).toBeDefined();
      expect(assignment?.sessionId).toBe('session-789');
      expect(assignment?.profileId).toBe('my-profile');
      expect(assignment?.profileName).toBe('My Profile');
    });
  });

  describe('getTaskSessionId', () => {
    it('should return session ID if set', () => {
      state.assignProfileToTask('task-1', 'profile-1', 'Profile 1', 'proactive');
      state.updateTaskSession('task-1', 'session-abc');

      expect(state.getTaskSessionId('task-1')).toBe('session-abc');
    });

    it('should return undefined if no session set', () => {
      state.assignProfileToTask('task-1', 'profile-1', 'Profile 1', 'proactive');

      expect(state.getTaskSessionId('task-1')).toBeUndefined();
    });

    it('should return undefined for non-existent task', () => {
      expect(state.getTaskSessionId('non-existent')).toBeUndefined();
    });
  });

  describe('clearTaskProfileAssignment', () => {
    it('should clear profile assignment for task', () => {
      state.assignProfileToTask('task-1', 'profile-1', 'Profile 1', 'proactive');
      state.clearTaskProfileAssignment('task-1');

      expect(state.getTaskProfileAssignment('task-1')).toBeUndefined();
    });

    it('should not affect other tasks', () => {
      state.assignProfileToTask('task-1', 'profile-1', 'Profile 1', 'proactive');
      state.assignProfileToTask('task-2', 'profile-2', 'Profile 2', 'proactive');

      state.clearTaskProfileAssignment('task-1');

      expect(state.getTaskProfileAssignment('task-2')).toBeDefined();
    });
  });

  describe('clear', () => {
    it('should clear all profile assignments', () => {
      state.assignProfileToTask('task-1', 'profile-1', 'Profile 1', 'proactive');
      state.assignProfileToTask('task-2', 'profile-2', 'Profile 2', 'proactive');

      state.clear();

      expect(state.getTaskProfileAssignment('task-1')).toBeUndefined();
      expect(state.getTaskProfileAssignment('task-2')).toBeUndefined();
    });
  });

  /**
   * A task id is a spec id, and every project numbers its tasks from 001, so the same id runs in
   * two projects at once. Nothing here may let one of them read, overwrite or remove the other's
   * state.
   */
  describe('the same task id in two projects', () => {
    beforeEach(() => {
      state.addRunning('001-add-login', 'project-1');
      state.addRunning('001-add-login', 'project-2');
      state.assignProfileToTask('001-add-login', 'profile-1', 'Profile 1', 'proactive', 'project-1');
      state.assignProfileToTask('001-add-login', 'profile-2', 'Profile 2', 'proactive', 'project-2');
    });

    it('keeps the two runs and their profiles apart', () => {
      expect(state.getTaskProfileAssignment('001-add-login', 'project-1')?.profileId).toBe('profile-1');
      expect(state.getTaskProfileAssignment('001-add-login', 'project-2')?.profileId).toBe('profile-2');

      const result = state.getRunningTasksByProfile();
      // Reported as plain task ids (the IPC payload's shape), so the shared id shows up twice
      expect(result.byProfile).toEqual({
        'profile-1': ['001-add-login'],
        'profile-2': ['001-add-login'],
      });
      expect(result.totalRunning).toBe(2);
    });

    it('removes only the run of the project it is told', () => {
      expect(state.removeRunning('001-add-login', 'project-2')).toBe(true);

      expect(state.isRunning('001-add-login', 'project-1')).toBe(true);
      expect(state.isRunning('001-add-login', 'project-2')).toBe(false);
      expect(state.getRunningTasksByProfile()).toEqual({
        byProfile: { 'profile-1': ['001-add-login'] },
        totalRunning: 1,
      });
    });

    it('keeps the sessions of the two runs apart', () => {
      state.updateTaskSession('001-add-login', 'session-1', undefined, 'project-1');
      state.updateTaskSession('001-add-login', 'session-2', undefined, 'project-2');

      expect(state.getTaskSessionId('001-add-login', 'project-1')).toBe('session-1');
      expect(state.getTaskSessionId('001-add-login', 'project-2')).toBe('session-2');
    });

    it('refuses a lookup that names no project and says which task it was asked about', () => {
      expect(state.removeRunning('001-add-login')).toBe(false);
      expect(state.isRunning('001-add-login')).toBe(false);
      expect(state.getTaskProfileAssignment('001-add-login')).toBeUndefined();

      // Both runs are still there, with their own profiles
      expect(state.getRunningTasksByProfile().totalRunning).toBe(2);
      expect(vi.mocked(appLog.warn).mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining('removeRunning: 001-add-login is in more than one project'),
        expect.stringContaining('isRunning: 001-add-login is in more than one project'),
        expect.stringContaining('getTaskProfileAssignment: 001-add-login is in more than one project'),
      ]);
    });

    it('adds no third assignment when a session update names no project', () => {
      state.updateTaskSession('001-add-login', 'session-x');

      expect(state.getTaskSessionId('001-add-login', 'project-1')).toBeUndefined();
      expect(state.getTaskSessionId('001-add-login', 'project-2')).toBeUndefined();
      // Nothing was stored under "no project" either, which a later bare lookup would have found
      expect(state.getRunningTasksByProfile().byProfile).toEqual({
        'profile-1': ['001-add-login'],
        'profile-2': ['001-add-login'],
      });
    });

    it('answers a lookup by task id alone once only one project runs it', () => {
      state.removeRunning('001-add-login', 'project-2');
      state.clearTaskProfileAssignment('001-add-login', 'project-2');

      expect(state.isRunning('001-add-login')).toBe(true);
      expect(state.getTaskProfileAssignment('001-add-login')?.profileId).toBe('profile-1');
      expect(state.removeRunning('001-add-login')).toBe(true);
    });
  });
});

/**
 * Every write in the project-keyed scheme has to take over an entry stored before any project was
 * known, rather than leave a second one beside it: two entries for one task make every later
 * bare-task-id lookup ambiguous, and the lookup then refuses - so the session id stops being
 * recorded and project-scoped readers keep answering from the older entry.
 */
describe('an assignment stored before the project was known', () => {
  it('is taken over by the first assignment that names a project', () => {
    const state = new AgentState();
    state.addRunning('001-add-login', 'project-1');
    state.assignProfileToTask('001-add-login', 'work', 'Work', 'manual');
    state.updateTaskSession('001-add-login', 'session-before');

    state.assignProfileToTask('001-add-login', 'personal', 'Personal', 'proactive', 'project-1');

    // One entry, under the project, carrying the session the projectless one had
    const assignment = state.getTaskProfileAssignment('001-add-login', 'project-1');
    expect(assignment?.profileId).toBe('personal');
    expect(assignment?.sessionId).toBe('session-before');
    // And a bare lookup still answers, which it could not do with two entries for the task
    expect(state.getTaskProfileAssignment('001-add-login')?.profileId).toBe('personal');
    // So the session id goes on being recorded without a project too
    state.updateTaskSession('001-add-login', 'session-after');
    expect(state.getTaskSessionId('001-add-login', 'project-1')).toBe('session-after');
  });
});
