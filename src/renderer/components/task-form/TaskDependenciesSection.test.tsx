/** @vitest-environment jsdom */
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../shared/i18n';
import type { Task } from '../../../shared/types';
import { TaskDependenciesSection } from './TaskDependenciesSection';

function ticket(id: string, extra: Partial<Task> = {}): Task {
  return { id, specId: id, projectId: 'p1', title: `Ticket ${id}`, status: 'backlog', ...extra } as Task;
}

const task = ticket('010-target', { metadata: { dependsOnTaskIds: ['001-auto', '002-old'] } });
const tickets = [
  task,
  ticket('001-auto'),
  ticket('002-old', { status: 'done' }),
  ticket('003-manual'),
  ticket('004-cycle', { metadata: { dependsOnTaskIds: [task.id] } }),
  ticket('005-foreign', { projectId: 'p2' }),
  ticket('006-archived', { metadata: { archivedAt: 'now' } }),
  ticket('007-complete', { status: 'done' }),
];

function Editor({ current = task }: { current?: Task }) {
  const [value, setValue] = useState(current.metadata?.dependsOnTaskIds ?? []);
  return <TaskDependenciesSection task={current} tasks={tickets} value={value} onChange={setValue} />;
}

afterEach(cleanup);

describe('manual dependencies', () => {
  it('preselects automatic and completed dependencies, supports search, add and removal', () => {
    render(<Editor />);
    expect(screen.getByRole('checkbox', { name: /#001/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /#002/ })).toBeChecked();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '#003' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /#003/ }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(screen.getByRole('checkbox', { name: /#003/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /#001/ })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /#002/ }));
    expect(screen.queryByRole('checkbox', { name: /#002/ })).not.toBeInTheDocument();
  });

  it('excludes self and foreign or inactive tickets and disables cycles', () => {
    render(<Editor />);
    for (const number of ['010', '005', '006', '007']) {
      expect(screen.queryByRole('checkbox', { name: new RegExp(`#${number}`) })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('checkbox', { name: /#004/ })).toBeDisabled();
    expect(screen.getByText('Would create a cycle')).toBeInTheDocument();
  });

  it('retains a missing dependency so a person can explicitly remove it', () => {
    render(<Editor current={ticket('010-target', { metadata: { dependsOnTaskIds: ['404-missing'] } })} />);
    const missing = screen.getByRole('checkbox', { name: /#404/ });
    expect(missing).toBeChecked();
    fireEvent.click(missing);
    expect(screen.queryByRole('checkbox', { name: /#404/ })).not.toBeInTheDocument();
  });

  it('does not edit dependencies on a running ticket', () => {
    render(<Editor current={{ ...task, status: 'in_progress' }} />);
    screen.getAllByRole('checkbox').forEach((input) => expect(input).toBeDisabled());
    expect(screen.getByText(/Stop and move it there before editing/)).toBeInTheDocument();
  });
});
