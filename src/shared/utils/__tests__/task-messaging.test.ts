import { describe, expect, it } from 'vitest';
import { parseSessionName, projectKey, taskSessionName } from '../task-messaging';

describe('task session names', () => {
  it('gives each project a short stable key', () => {
    expect(projectKey('project-1')).toMatch(/^[a-z0-9]{6}$/);
    expect(projectKey('project-1')).toBe(projectKey('project-1'));
    expect(projectKey('project-1')).not.toBe(projectKey('project-2'));
  });

  it('names task sessions with addressable characters only', () => {
    const key = projectKey('p1');
    expect(taskSessionName('p1', '012-add-login')).toBe(`wb-${key}-012-add-login`);
    expect(taskSessionName('p1', '013 fix: "quotes"/paths')).toMatch(/^wb-[a-z0-9]{6}-[A-Za-z0-9_-]+$/);
  });

  it('parses names back to the project key and task', () => {
    const key = projectKey('p1');
    expect(parseSessionName(taskSessionName('p1', '012-add-login'))).toEqual({ projectKey: key, specId: '012-add-login' });
    expect(parseSessionName(`@${taskSessionName('p1', '013')}`)).toEqual({ projectKey: key, specId: '013' });
    expect(parseSessionName('my-helper-agent')).toBeNull();
    expect(parseSessionName('wb-short-x')).toBeNull();
  });
});
