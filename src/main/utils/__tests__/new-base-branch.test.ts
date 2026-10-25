import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGit = vi.hoisted(() => vi.fn(async (_args: string[], _options?: unknown) => ({ stdout: '', stderr: '' })));
vi.mock('../git-exec', () => ({ git: mockGit }));

const findRef = vi.hoisted(() => vi.fn(async (_cwd: string, _branch: string, _options?: unknown): Promise<string | null> => null));
vi.mock('../base-branch', () => ({ findBaseBranchRef: findRef }));

vi.mock('../../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { ensureNewBaseBranch } from '../new-base-branch';

/** Refs the fake repository has */
function repoWith(refs: Record<string, string>): void {
  findRef.mockImplementation(async (_cwd, branch) => refs[branch] ?? null);
}

describe('ensureNewBaseBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGit.mockImplementation(async () => ({ stdout: '', stderr: '' }));
  });

  it('skips a branch that exists already', async () => {
    repoWith({ 'feature/login': 'refs/heads/feature/login', develop: 'refs/heads/develop' });

    const result = await ensureNewBaseBranch('/p', 'feature/login', 'develop', { push: true });

    expect(result).toEqual({ created: false });
    expect(mockGit).not.toHaveBeenCalled();
  });

  it('creates a missing branch from the branch the task named', async () => {
    repoWith({ develop: 'refs/heads/develop' });

    const result = await ensureNewBaseBranch('/p', 'feature/login', 'develop', { push: false });

    expect(result).toEqual({ created: true, from: 'refs/heads/develop' });
    expect(mockGit).toHaveBeenCalledTimes(1);
    expect(mockGit).toHaveBeenCalledWith(
      ['branch', '--no-track', 'feature/login', 'refs/heads/develop'],
      expect.objectContaining({ cwd: '/p' }),
    );
  });

  it('pushes a branch it created when pushing is on and origin exists', async () => {
    repoWith({ develop: 'refs/heads/develop' });
    mockGit.mockImplementation(async (args: string[]) => ({
      stdout: args[0] === 'remote' ? 'git@example.com:o/r.git\n' : '',
      stderr: '',
    }));

    await ensureNewBaseBranch('/p', 'feature/login', 'develop', { push: true });

    expect(mockGit).toHaveBeenCalledWith(
      ['push', '--set-upstream', 'origin', 'refs/heads/feature/login:refs/heads/feature/login'],
      expect.objectContaining({ cwd: '/p' }),
    );
  });

  it('does not push without an origin, and a failed push does not fail the task', async () => {
    repoWith({ develop: 'refs/heads/develop' });
    await ensureNewBaseBranch('/p', 'a', 'develop', { push: true });
    expect(mockGit.mock.calls.some(([args]) => args[0] === 'push')).toBe(false);

    mockGit.mockImplementation(async (args: string[]) => {
      if (args[0] === 'push') throw new Error('rejected');
      return { stdout: args[0] === 'remote' ? 'url\n' : '', stderr: '' };
    });
    await expect(ensureNewBaseBranch('/p', 'b', 'develop', { push: true })).resolves.toMatchObject({ created: true });
  });

  it('fails with a clear error when the start branch does not exist', async () => {
    repoWith({});

    await expect(ensureNewBaseBranch('/p', 'feature/login', 'gone', { push: false })).rejects.toThrow(
      /"gone", does not exist/,
    );
    expect(mockGit).not.toHaveBeenCalled();
  });

  it('fails with a clear error when git refuses to create the branch', async () => {
    repoWith({ develop: 'refs/heads/develop' });
    mockGit.mockRejectedValue(new Error('fatal: boom'));

    await expect(ensureNewBaseBranch('/p', 'feature/login', 'develop', { push: false })).rejects.toThrow(
      /Cannot create the base branch "feature\/login" from refs\/heads\/develop: fatal: boom/,
    );
  });

  it('treats a branch another task made in the meantime as existing', async () => {
    let calls = 0;
    findRef.mockImplementation(async (_cwd, branch) => {
      if (branch === 'develop') return 'refs/heads/develop';
      return ++calls > 1 ? 'refs/heads/feature/login' : null;
    });
    mockGit.mockRejectedValue(new Error('fatal: a branch named feature/login already exists'));

    await expect(ensureNewBaseBranch('/p', 'feature/login', 'develop', { push: false })).resolves.toEqual({
      created: false,
    });
  });

  it('rejects an illegal branch name without running git', async () => {
    repoWith({ develop: 'refs/heads/develop' });

    await expect(ensureNewBaseBranch('/p', 'bad name', 'develop', { push: false })).rejects.toThrow(
      /not a valid branch name/,
    );
    expect(mockGit).not.toHaveBeenCalled();
  });
});
