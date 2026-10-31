/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../shared/i18n';
import { MemoryReviewPanel } from './MemoryReviewPanel';
import { useProjectMemoryStore } from '../../stores/project-memory-store';
import { useProjectStore } from '../../stores/project-store';
import type { Project } from '../../../shared/types';
import type { ProjectMemory } from '../../../shared/types/project-memory';

const memory = (overrides: Partial<ProjectMemory> = {}): ProjectMemory => ({
  id: 'memory', projectId: 'p', status: 'proposed', revision: 1, verification: 'unverified',
  kind: 'lesson', title: 'Task finding', body: 'Check the observed result.', at: '2026-10-30T12:00:00Z',
  source: { type: 'task', reference: 'task-1', evidence: 'Task report.' }, history: [], ...overrides,
});
beforeEach(() => {
  useProjectStore.setState({ projects: [{ id: 'p', settings: { selfImprove: true } } as Project] });
  useProjectMemoryStore.setState({ entries: {}, contexts: {}, requiresRestart: false });
});
afterEach(cleanup);

it('shows consequential decisions and opens the project review inbox', () => {
  useProjectMemoryStore.setState({ entries: { p: [memory({ reviewReason: 'conflict' }), memory({ id: 'procedure', reviewReason: 'procedure' }), memory({ id: 'active', status: 'active' })] } });
  const open = vi.fn(); window.addEventListener('open-project-memory', open);
  render(<MemoryReviewPanel projectId="p" />);
  expect(screen.getByRole('status')).toHaveTextContent('Memory decisions: 1 · conflicts: 1');
  fireEvent.click(screen.getByRole('button', { name: 'Review decisions' }));
  expect(open.mock.calls[0][0].detail).toEqual({ projectId: 'p' });
  window.removeEventListener('open-project-memory', open);
});

it('does not interrupt for a backlog of ordinary task findings, procedures or inferred preferences', () => {
  useProjectMemoryStore.setState({ entries: { p: [
    ...Array.from({ length: 90 }, (_, index) => memory({ id: String(index), reviewReason: 'unverified' })),
    memory({ kind: 'procedure', reviewReason: 'procedure' }), memory({ kind: 'preference', reviewReason: 'preference' }),
  ] } });
  render(<MemoryReviewPanel projectId="p" />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('shows conflicts and replacements of active guidance even before their review reason is classified', () => {
  useProjectMemoryStore.setState({ entries: { p: [
    memory({ id: 'active', status: 'active' }),
    memory({ id: 'conflict', conflictsWith: ['active'] }),
    memory({ id: 'replacement', supersedes: 'active' }),
    memory({ id: 'stale-reference', conflictsWith: ['obsolete'] }),
    memory({ id: 'obsolete', status: 'obsolete' }),
  ] } });
  render(<MemoryReviewPanel projectId="p" />);
  expect(screen.getByRole('status')).toHaveTextContent('Memory decisions: 2 · conflicts: 2');
});

it('shows an explicit user-authored proposal as a decision', () => {
  useProjectMemoryStore.setState({ entries: { p: [memory({ source: { type: 'user', reference: 'Owner instruction', evidence: 'Explicit guidance.' } })] } });
  render(<MemoryReviewPanel projectId="p" />);
  expect(screen.getByRole('status')).toHaveTextContent('Memory decisions: 1 · conflicts: 0');
});
