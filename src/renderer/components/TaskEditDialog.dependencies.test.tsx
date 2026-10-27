/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../shared/i18n';
import type { Task } from '../../shared/types';
import { TaskEditDialog } from './TaskEditDialog';
import { useTaskStore } from '../stores/task-store';

vi.mock('./task-form/TaskGitOptions', () => ({
  PROJECT_DEFAULT_BRANCH: 'project-default',
  useTaskGitOptions: () => ({ projectDefaultBranch: 'main', projectPushNewBranches: false, isLocalBranch: () => true }),
  TaskGitOptionsSection: () => null,
}));

vi.mock('./task-form/TaskFormFields', () => ({
  TaskFormFields: ({ description, onDescriptionChange, error }: { description: string; onDescriptionChange: (text: string) => void; error: string | null }) => (
    <>
      <textarea aria-label="Description" value={description} onChange={(event) => onDescriptionChange(event.target.value)} />
      {error && <p role="alert">{error}</p>}
    </>
  ),
}));

const task = {
  id: '010-target', specId: '010-target', projectId: 'p1', title: 'Target', description: 'Build the feature', status: 'queue',
  metadata: { dependsOnTaskIds: ['001-auto'], sourceType: 'manual' }, createdAt: new Date(), updatedAt: new Date(),
} as Task;
const auto = { ...task, id: '001-auto', specId: '001-auto', title: 'Automatic prerequisite', metadata: {} };
const manual = { ...task, id: '002-manual', specId: '002-manual', title: 'Manual prerequisite', metadata: {} };
const updateTask = vi.fn();

beforeEach(() => {
  useTaskStore.setState({ tasks: [task, auto, manual] });
  window.electronAPI.updateTask = updateTask;
  updateTask.mockReset().mockImplementation(async (_id, updates) => ({
    success: true, data: { ...task, ...updates, metadata: { ...task.metadata, ...updates.metadata } },
  }));
});
afterEach(cleanup);

describe('saving manual ticket dependencies', () => {
  it('adds to automatic dependencies and persists through the project-scoped edit path', async () => {
    const close = vi.fn();
    render(<TaskEditDialog task={task} open onOpenChange={close} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /#002/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      metadata: expect.objectContaining({ dependsOnTaskIds: ['001-auto', '002-manual'] }),
    }), 'p1');
    expect(useTaskStore.getState().tasks[0].metadata?.dependsOnTaskIds).toEqual(['001-auto', '002-manual']);
  });

  it('saves an empty list when the final dependency is removed', async () => {
    render(<TaskEditDialog task={task} open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /#001/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ metadata: expect.objectContaining({ dependsOnTaskIds: [] }) }), 'p1'));
  });

  it('retains local choices and newly discovered prerequisites when the ticket updates while editing', async () => {
    const { rerender } = render(<TaskEditDialog task={task} open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /#001/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /#002/ }));
    const discovered = { ...task, metadata: { ...task.metadata, dependsOnTaskIds: ['001-auto', '003-discovered'] } };
    rerender(<TaskEditDialog task={discovered} open onOpenChange={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: /#001/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /#002/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /#003/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      metadata: expect.objectContaining({ dependsOnTaskIds: ['003-discovered', '002-manual'] }),
    }), 'p1'));
  });

  it('omits unchanged dependencies from unrelated edits and cancels without persisting', async () => {
    render(<TaskEditDialog task={task} open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Updated request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalled());
    expect(updateTask.mock.calls[0][1].metadata).not.toHaveProperty('dependsOnTaskIds');
    cleanup();
    updateTask.mockClear();
    render(<TaskEditDialog task={task} open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /#002/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and shows failure if persistence fails', async () => {
    updateTask.mockResolvedValueOnce({ success: false, error: 'Save failed' });
    const close = vi.fn();
    render(<TaskEditDialog task={task} open onOpenChange={close} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /#002/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to update/);
    expect(close).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[0].metadata?.dependsOnTaskIds).toEqual(['001-auto']);
  });
});
