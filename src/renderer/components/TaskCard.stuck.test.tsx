/**
 * @vitest-environment jsdom
 */
/**
 * A task left "in progress" by an app restart (its run is gone) is stuck. The card must offer to
 * continue it, not only to start it over: Resume for an unfinished run, Move to review for a run
 * that had finished.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TaskCard } from './TaskCard';
import type { Task } from '../../shared/types';
import type { ClaudeRunInfo } from '../../shared/types/claude-code';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

let running = false;
const recoverStuckTask = vi.fn(async () => ({ success: true, data: { taskId: 't1', recovered: true, newStatus: 'in_progress' } }));

beforeEach(() => {
  running = false;
  recoverStuckTask.mockClear();
  // Every other electronAPI call the card makes answers "nothing"
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
    {
      checkTaskRunning: async () => ({ success: true, data: running }),
      recoverStuckTask,
    } as Record<string, unknown>,
    { get: (target, key: string) => target[key] ?? (async () => ({ success: true, data: null })) }
  );
});

const run = (phases: ClaudeRunInfo['phases']): ClaudeRunInfo =>
  ({ version: 1, phases, subagents: [], totalCostUsd: 0 } as unknown as ClaudeRunInfo);

const stuckTask = (claudeRun: ClaudeRunInfo): Task =>
  ({
    id: 't1',
    specId: '002-belief',
    projectId: 'p1',
    title: 'Belief updating',
    description: 'Build stage B',
    status: 'in_progress',
    subtasks: [],
    logs: [],
    metadata: {},
    claudeRun,
    createdAt: new Date('2026-10-24T18:31:00Z'),
    updatedAt: new Date('2026-10-24T21:30:00Z'),
  } as unknown as Task);

describe('a stuck task card', () => {
  it('offers Resume for a run that stopped mid-implementation, and resumes it in place', async () => {
    const task = stuckTask(run([
      { name: 'plan', startedAt: '2026-10-25T03:44:20Z', endedAt: '2026-10-25T03:47:01Z' },
      { name: 'implement', startedAt: '2026-10-25T03:47:01Z' },
    ]));
    render(<TaskCard task={task} onClick={() => undefined} />);

    const resume = await screen.findByRole('button', { name: 'actions.resume' });
    expect(screen.getByRole('button', { name: 'actions.startOver' })).toBeInTheDocument();
    fireEvent.click(resume);

    await waitFor(() => expect(recoverStuckTask).toHaveBeenCalledWith('t1', { autoRestart: true }, 'p1'));
  });

  it('offers Move to review for a run that had finished, without running it again', async () => {
    const task = stuckTask(run([
      { name: 'implement', startedAt: '2026-10-25T03:47:01Z', endedAt: '2026-10-25T04:30:00Z' },
      { name: 'validate', startedAt: '2026-10-25T04:30:00Z', endedAt: '2026-10-25T04:40:00Z' },
    ]));
    render(<TaskCard task={task} onClick={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: 'actions.moveToReview' }));

    await waitFor(() => expect(recoverStuckTask).toHaveBeenCalledWith('t1', { autoRestart: false }, 'p1'));
  });

  it('clears Stuck within seconds once the app resumes the task on its own', async () => {
    const task = stuckTask(run([{ name: 'implement', startedAt: '2026-10-25T03:47:01Z' }]));
    render(<TaskCard task={task} onClick={() => undefined} />);
    await screen.findByRole('button', { name: 'actions.resume' });

    // The app's startup resume brings the run back; the task keeps its in-progress status
    running = true;
    await waitFor(() => expect(screen.queryByRole('button', { name: 'actions.resume' })).not.toBeInTheDocument(), { timeout: 5000 });
  }, 10_000);
});
