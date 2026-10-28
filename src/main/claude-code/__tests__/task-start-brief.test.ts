import { beforeEach, describe, expect, it, vi } from 'vitest';
import { git } from '../../utils/git-exec';
import { buildTaskStartBrief } from '../task-start-brief';

vi.mock('../../utils/git-exec', () => ({ git: vi.fn() }));
const mockedGit = vi.mocked(git);
beforeEach(() => mockedGit.mockReset());

describe('task starting brief', () => {
  it('provides branch, dirty/untracked paths and committed change scope without claiming checks passed', async () => {
    mockedGit.mockResolvedValueOnce({ stdout: '## workbench/task\n M src/app.ts\n?? notes.txt\n', stderr: '' });
    mockedGit.mockResolvedValueOnce({ stdout: ' src/feature.ts | 4 ++++\n', stderr: '' });
    const brief = await buildTaskStartBrief({ cwd: '/worktree', baseBranch: 'main', verification: ['npm test'] });
    expect(brief).toContain(' M src/app.ts');
    expect(brief).toContain('?? notes.txt');
    expect(brief).toContain('src/feature.ts | 4');
    expect(brief).toContain('not test results');
    expect(brief).toContain('"npm test"');
    expect(mockedGit.mock.calls.map(([args]) => args)).toEqual([
      ['status', '--short', '--branch', '--untracked-files=normal'],
      ['diff', '--stat', 'main...HEAD', '--'],
    ]);
    expect(mockedGit.mock.calls.every(([, options]) => options.isolated)).toBe(true);
  });

  it('keeps a useful bounded brief when either inspection fails or produces excessive output', async () => {
    mockedGit.mockRejectedValueOnce(new Error('Git unavailable'));
    mockedGit.mockResolvedValueOnce({ stdout: 'file.ts | 1 +\n'.repeat(10_000), stderr: '' });
    const brief = await buildTaskStartBrief({ cwd: '/worktree', baseBranch: 'main', verification: Array(100).fill('x'.repeat(1000)) });
    expect(brief).toContain('Unavailable; inspect Git state');
    expect(brief).toContain('Snapshot truncated');
    expect(brief).not.toContain('(no committed differences)');
    expect(brief.length).toBeLessThan(4_000);
  });
});
