/** @vitest-environment jsdom */
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../shared/i18n';
import type { Task } from '../../shared/types';
import type { AutoMergeProgress } from '../../shared/types/task';
import { TaskMergeStatus } from './TaskMergeStatus';
import { TaskCard } from './TaskCard';

afterEach(cleanup);
const at = '2026-10-27T20:40:46Z';
const task = (phase?: AutoMergeProgress['phase']): Task => ({
  id: '120-room', specId: '120-room', projectId: 'p', title: 'Operation Room', description: '', status: 'human_review', reviewReason: 'completed',
  createdAt: new Date(at), updatedAt: new Date(at), subtasks: [], logs: [],
  metadata: phase ? { autoMergeProgress: { phase, targetBranch: 'main', conflictCount: 4, startedAt: at, at } } : {},
} as Task);

it('shows each live phase with an indicator and exposes the exact update time in details', () => {
  const labels = { queued: 'Queued for merge into main', merging: 'Merging into main', resolving: 'Resolving conflicts in 4 files with main', verifying: 'Verifying merge into main', pushing: 'Pushing main' } as const;
  const view = render(<TaskMergeStatus task={task('queued')} />);
  for (const [phase, label] of Object.entries(labels)) {
    view.rerender(<TaskMergeStatus task={task(phase as AutoMergeProgress['phase'])} />);
    expect(screen.getByRole('status', { name: 'Merge status' })).toHaveTextContent(label);
    expect(screen.getByRole('status').querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.getByRole('status').querySelector('time')).toHaveAttribute('dateTime', at);
    expect(screen.queryByText('Merged into main')).not.toBeInTheDocument();
  }
});

it('keeps merged status on Done and distinguishes a failed push from a failed merge', () => {
  const t = task('pushing'); t.status = 'done';
  t.metadata!.autoMerge = { branch: 'main', sha: 'a'.repeat(40), at: '2026-10-27T20:41:00Z', pushError: 'Network unavailable' };
  const view = render(<TaskMergeStatus task={t} />);
  expect(screen.getByRole('status')).toHaveTextContent('Merged into main');
  expect(screen.getByRole('status')).toHaveTextContent('Network unavailable');
  expect(screen.getByRole('status').querySelector('.animate-spin')).not.toBeInTheDocument();
  view.rerender(<TaskMergeStatus task={t} compact />);
  expect(screen.getByRole('status')).toHaveTextContent('Merged into main · push failed');
  t.metadata!.autoMerge.revertedAt = '2026-10-27T20:42:00Z';
  view.rerender(<TaskMergeStatus task={{ ...t }} compact />);
  expect(screen.getByRole('status')).toHaveTextContent('Merge reverted on main');
});

it('shows blocked and interrupted states without a spinner or invented completion', () => {
  const t = task(); t.metadata!.autoMergeBlocked = { reason: 'conflicts', message: 'Both routes must survive', at };
  const view = render(<TaskMergeStatus task={t} />);
  expect(screen.getByRole('status')).toHaveTextContent('Merge blocked');
  expect(screen.getByRole('status')).toHaveTextContent('Both routes must survive');
  view.rerender(<TaskMergeStatus task={task('interrupted')} />);
  expect(screen.getByRole('status')).toHaveTextContent('Merge interrupted');
  expect(screen.getByRole('status')).toHaveTextContent('The app stopped before this merge finished');
  expect(screen.getByRole('status').querySelector('.animate-spin')).not.toBeInTheDocument();
});

it('updates a memoized board card as only merge progress changes, then shows its merged branch', () => {
  const onClick = () => {};
  const view = render(<TaskCard task={task('queued')} onClick={onClick} />);
  expect(screen.getByRole('status')).toHaveTextContent('Queued for merge into main');
  view.rerender(<TaskCard task={task('resolving')} onClick={onClick} />);
  expect(screen.getByRole('status')).toHaveTextContent('Resolving conflicts in 4 files');
  const merged = task(); merged.metadata!.autoMerge = { branch: 'release', sha: 'b'.repeat(40), at, pushed: true };
  view.rerender(<TaskCard task={merged} onClick={onClick} />);
  expect(screen.getByRole('status')).toHaveTextContent('Merged into release');
});

it('does not label ordinary review tasks as merging or merged', () => {
  render(<TaskMergeStatus task={task()} />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
