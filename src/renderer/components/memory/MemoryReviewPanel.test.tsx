/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../shared/i18n';
import { MemoryReviewPanel } from './MemoryReviewPanel';
import { useProjectMemoryStore } from '../../stores/project-memory-store';
import { useProjectStore } from '../../stores/project-store';
import type { Project } from '../../../shared/types';
import type { ProjectMemory } from '../../../shared/types/project-memory';
afterEach(cleanup);
it('keeps review counts visible and opens the project review inbox', () => {
  useProjectStore.setState({ projects: [{ id: 'p', settings: { selfImprove: true } } as Project] });
  useProjectMemoryStore.setState({ entries: { p: [{ status: 'proposed', reviewReason: 'conflict' }, { status: 'proposed', reviewReason: 'procedure' }, { status: 'active' }] as ProjectMemory[] } });
  const open = vi.fn(); window.addEventListener('open-project-memory', open);
  render(<MemoryReviewPanel projectId="p" />);
  expect(screen.getByRole('status')).toHaveTextContent('Memory needs review: 2 pending · conflicts: 1');
  fireEvent.click(screen.getByRole('button', { name: 'Review memories' }));
  expect(open.mock.calls[0][0].detail).toEqual({ projectId: 'p' });
  window.removeEventListener('open-project-memory', open);
});
