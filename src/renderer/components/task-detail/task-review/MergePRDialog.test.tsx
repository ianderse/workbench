/**
 * @vitest-environment jsdom
 */
/**
 * MergePRDialog: merges the task's PR into the chosen branch, shows the merge's steps while it
 * runs and what Claude Code resolved when it's done.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { MergePRDialog } from './MergePRDialog';
import type { MergePRProgress, Task, WorktreeMergePRResult, WorktreeStatus } from '../../../../shared/types';

vi.mock('../../../hooks/useProjectBranches', () => ({
  useProjectBranches: () => ({
    branches: [
      { name: 'develop', type: 'local', displayName: 'develop' },
      { name: 'origin/main', type: 'remote', displayName: 'origin/main' }
    ],
    detectedBranch: 'develop',
    isLoading: false,
    error: null,
    refresh: vi.fn()
  })
}));

let progressListener: ((taskId: string, progress: MergePRProgress) => void) | null = null;
Object.defineProperty(window, 'electronAPI', {
  value: {
    openExternal: vi.fn(),
    onMergePRProgress: (callback: (taskId: string, progress: MergePRProgress) => void) => {
      progressListener = callback;
      return () => { progressListener = null; };
    }
  },
  writable: true
});

const task: Task = {
  id: 'task-1',
  specId: '001-auth',
  projectId: 'project-1',
  title: 'Add auth',
  description: 'Add login',
  status: 'pr_created',
  metadata: { prUrl: 'https://github.com/example/repo/pull/7', prState: 'open', baseBranch: 'develop' },
  subtasks: [],
  logs: [],
  createdAt: new Date(),
  updatedAt: new Date()
};

const worktreeStatus: WorktreeStatus = {
  exists: true,
  worktreePath: '/wt',
  branch: 'auto-claude/001-auth',
  baseBranch: 'develop',
  commitCount: 2,
  filesChanged: 3,
  additions: 10,
  deletions: 1
};

describe('MergePRDialog', () => {
  const onOpenChange = vi.fn();
  const onMergePR = vi.fn<(options: { targetBranch?: string }) => Promise<WorktreeMergePRResult>>();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges into the task's base branch and shows the steps and the resolved conflicts", async () => {
    let finish!: (result: WorktreeMergePRResult) => void;
    onMergePR.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<MergePRDialog open task={task} worktreeStatus={worktreeStatus} onOpenChange={onOpenChange} onMergePR={onMergePR} />);

    expect(screen.getByText('auto-claude/001-auth')).toBeInTheDocument();
    expect(screen.getByText('example/repo/pull/7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Merge pull request' }));
    expect(onMergePR).toHaveBeenCalledWith({ targetBranch: 'develop' });

    act(() => progressListener?.('task-1', { step: 'pulling', params: { target: 'develop' } }));
    expect(screen.getByText('Pulling develop into the task branch')).toBeInTheDocument();
    act(() => progressListener?.('other-task', { step: 'merging' }));
    expect(screen.queryByText('Merging the pull request')).not.toBeInTheDocument();

    await act(async () => finish({ success: true, targetBranch: 'develop', conflictedFiles: ['a.ts', 'b.ts'], summary: 'Kept both changes' }));
    expect(screen.getByText('Pull request merged into develop')).toBeInTheDocument();
    expect(screen.getByText('Claude Code resolved the conflicts in 2 files')).toBeInTheDocument();
    expect(screen.getByText('Kept both changes')).toBeInTheDocument();
  });

  it('shows why a merge failed and can try again', async () => {
    onMergePR.mockResolvedValueOnce({ success: false, error: 'The merge would lose changes from develop (a.ts: x)' });
    onMergePR.mockResolvedValueOnce({ success: true, targetBranch: 'develop', conflictedFiles: [] });
    render(<MergePRDialog open task={task} worktreeStatus={worktreeStatus} onOpenChange={onOpenChange} onMergePR={onMergePR} />);

    fireEvent.click(screen.getByRole('button', { name: 'Merge pull request' }));
    await waitFor(() => expect(screen.getByText('The merge would lose changes from develop (a.ts: x)')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Pull request merged into develop')).toBeInTheDocument());
    expect(onMergePR).toHaveBeenCalledTimes(2);
  });
});
