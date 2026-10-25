/**
 * @vitest-environment jsdom
 */
/**
 * Break into tasks in the New Task dialog: a stray click or Escape must not close the dialog while
 * a breakdown works or its review is open (a 6 minute run was lost that way); stopping a long run
 * asks, and offers to keep it running in the background; a stored proposal reopens on its review step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TaskCreationWizard } from './TaskCreationWizard';
import type { PendingBreakdownReview } from '../stores/breakdown-review-store';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const api = {
  breakDownTask: vi.fn(() => new Promise(() => undefined)),
  cancelBreakDownTask: vi.fn(),
  saveBreakdownProposal: vi.fn(async () => ({ success: true })),
  dismissQueueProposal: vi.fn(async () => ({ success: true })),
  onBreakDownProgress: vi.fn(() => () => undefined),
};

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockClear());
  localStorage.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(api as Record<string, unknown>, {
    get: (target, key: string) => target[key] ?? (async () => ({ success: true, data: [] })),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const pending: PendingBreakdownReview = {
  projectId: 'p1',
  proposalId: 'prop-1',
  prompt: 'Build from docs/A.md',
  breakdown: {
    tasks: [
      { key: 't1', title: 'Set up the model', description: 'Do it', dependsOn: [], dependsOnExisting: [] },
      { key: 't2', title: 'Build the API', description: 'Then this', dependsOn: ['t1'] },
    ],
    batchId: 'batch-1',
    specSources: ['docs/A.md'],
  },
};

function renderWizard(extra: { initialBreakdown?: PendingBreakdownReview; onBreakdownConsumed?: () => void } = {}) {
  const onOpenChange = vi.fn();
  const view = render(<TaskCreationWizard projectId="p1" open onOpenChange={onOpenChange} {...extra} />);
  return { onOpenChange, ...view };
}

async function startBreakdown() {
  const textarea = document.querySelector('textarea');
  expect(textarea).not.toBeNull();
  fireEvent.change(textarea!, { target: { value: 'Build the thing' } });
  fireEvent.click(screen.getByRole('button', { name: 'tasks:wizard.breakIntoTasks' }));
  await screen.findByText('tasks:breakdown.working');
}

describe('closing the dialog while a breakdown works', () => {
  it('stays open on a click outside and on Escape, and a short run is stopped without asking', async () => {
    const { onOpenChange } = renderWizard();
    await startBreakdown();

    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText('tasks:breakdown.working')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'tasks:breakdown.cancel' }));
    expect(api.cancelBreakDownTask).toHaveBeenCalled();
    expect(screen.queryByText('tasks:breakdown.stopTitle')).not.toBeInTheDocument();
  });

  it('asks before stopping a long run, and can keep it working in the background', async () => {
    const { onOpenChange } = renderWizard();
    await startBreakdown();

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 45_000);
    fireEvent.click(screen.getByRole('button', { name: 'tasks:breakdown.cancel' }));
    expect(await screen.findByText('tasks:breakdown.stopTitle')).toBeInTheDocument();
    expect(api.cancelBreakDownTask).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'tasks:breakdown.background' }));
    expect(api.cancelBreakDownTask).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    vi.restoreAllMocks();
  });
});

describe('reviewing a stored proposal', () => {
  it('opens on the review step with the stored tickets and their batch', async () => {
    const consumed = vi.fn();
    const { onOpenChange } = render(
      <TaskCreationWizard projectId="p1" open onOpenChange={() => undefined} initialBreakdown={pending} onBreakdownConsumed={consumed} />
    ) && { onOpenChange: undefined };
    void onOpenChange;
    expect(await screen.findByDisplayValue('Set up the model')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Build the API')).toBeInTheDocument();
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(screen.getByText('tasks:breakdown.createCount')).toBeInTheDocument();
  });

  it('does not close on a click outside, and Discard dismisses the stored proposal', async () => {
    const { onOpenChange } = renderWizard({ initialBreakdown: pending });
    await screen.findByDisplayValue('Set up the model');

    fireEvent.pointerDown(document.body);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'buttons.close' }));
    expect(await screen.findByText('tasks:breakdown.leaveTitle')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'tasks:breakdown.discard' }));
    expect(api.dismissQueueProposal).toHaveBeenCalledWith('p1', 'prop-1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('saves the edits of a review for later over its stored proposal', async () => {
    renderWizard({ initialBreakdown: pending });
    await screen.findByDisplayValue('Set up the model');
    fireEvent.click(screen.getByRole('button', { name: 'buttons.close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'tasks:breakdown.saveForLater' }));
    expect(api.saveBreakdownProposal).toHaveBeenCalledWith(
      'p1', 'Build from docs/A.md', [], expect.objectContaining({ batchId: 'batch-1' }), 'prop-1'
    );
  });

  it('retries a failed run: the prompt is back in the form and the failed entry goes away on the new run', async () => {
    const consumed = vi.fn();
    renderWizard({ initialBreakdown: { projectId: 'p1', proposalId: 'failed-1', prompt: 'Build from docs/A.md' }, onBreakdownConsumed: consumed });
    expect(await screen.findByDisplayValue('Build from docs/A.md')).toBeInTheDocument();
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(api.dismissQueueProposal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'tasks:wizard.breakIntoTasks' }));
    expect(api.dismissQueueProposal).toHaveBeenCalledWith('p1', 'failed-1');
  });
});
