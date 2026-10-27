/**
 * @vitest-environment jsdom
 */
/**
 * OMP batches tool calls: one reply can read two files, so its tool rows share a timestamp and a
 * tool name. Their React keys must still be unique (a duplicate key can drop or repeat log rows).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settings-store';
import { TaskLogs } from '../TaskLogs';
import type { TaskLogs as TaskLogsData, TaskLogEntry, TaskPhaseLog } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const at = '2026-10-25T14:39:03.083Z';
const entry = (fields: Partial<TaskLogEntry>): TaskLogEntry =>
  ({ timestamp: at, phase: 'coding', content: '', ...fields }) as TaskLogEntry;
const phase = (name: TaskPhaseLog['phase'], entries: TaskLogEntry[]): TaskPhaseLog =>
  ({ phase: name, status: entries.length ? 'completed' : 'pending', started_at: entries.length ? at : null, completed_at: null, entries });

beforeEach(() => useSettingsStore.getState().updateSettings({ logOrder: 'chronological' }));
afterEach(cleanup);

describe('task log rows', () => {
  it('gives two tool calls of one reply distinct keys', () => {
    const logs: TaskLogsData = {
      spec_id: '001',
      created_at: at,
      updated_at: at,
      phases: {
        planning: phase('planning', []),
        coding: phase('coding', [
          entry({ type: 'tool_start', tool_name: 'Read', content: 'Read: a.ts', tool_use_id: 'c1' }),
          entry({ type: 'tool_start', tool_name: 'Read', content: 'Read: b.ts', tool_use_id: 'c2' }),
          entry({ type: 'tool_end', tool_name: 'Read', content: 'Read done', tool_use_id: 'c1' }),
          entry({ type: 'tool_end', tool_name: 'Read', content: 'Read done', tool_use_id: 'c2' }),
        ]),
        validation: phase('validation', []),
      },
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<TaskLogs phaseLogs={logs} isSettled isExpanded onToggle={() => undefined} />);
    const duplicateKey = errors.mock.calls.some((args) => args.some((a) => typeof a === 'string' && a.includes('same key')));
    errors.mockRestore();
    expect(duplicateKey).toBe(false);
  });
});

it('shows the latest activity first in a 501-line log and reverses legacy logs without changing their source', () => {
  useSettingsStore.getState().updateSettings({ logOrder: 'reverse-chronological' });
  const entries = Array.from({ length: 501 }, (_, index) => entry({ type: 'text', content: `activity-${String(index).padStart(3, '0')}`, timestamp: new Date(Date.parse(at) + index * 1000).toISOString() }));
  const logs: TaskLogsData = { spec_id: '001', created_at: at, updated_at: at, phases: { planning: phase('planning', []), coding: phase('coding', entries), validation: phase('validation', []) } };
  const view = render(<TaskLogs phaseLogs={logs} isSettled isExpanded onToggle={() => undefined} />);
  expect(view.container.textContent!.indexOf('activity-500')).toBeLessThan(view.container.textContent!.indexOf('activity-000'));
  expect(entries[0].content).toBe('activity-000');
  const legacy = ['oldest entry', 'newest entry'];
  view.rerender(<TaskLogs phaseLogs={null} legacyLogs={legacy} isSettled isExpanded onToggle={() => undefined} />);
  expect(view.container.querySelector('pre')!.textContent).toBe('newest entry\noldest entry');
  expect(legacy).toEqual(['oldest entry', 'newest entry']);
});

it('keeps expanded tool output open as new activity arrives and places a completed tool at its latest activity', () => {
  useSettingsStore.getState().updateSettings({ logOrder: 'reverse-chronological' });
  const entries = [entry({ type: 'tool_start', tool_name: 'Read', tool_input: 'a.ts', tool_use_id: 'c1' }), entry({ type: 'text', timestamp: '2026-10-25T14:40:00Z', content: 'intermediate activity' }), entry({ type: 'tool_end', tool_name: 'Read', tool_use_id: 'c1', timestamp: '2026-10-25T14:41:00Z', content: 'Read done', detail: 'expanded output stays visible' })];
  const logs: TaskLogsData = { spec_id: '001', created_at: at, updated_at: at, phases: { planning: phase('planning', []), coding: phase('coding', entries), validation: phase('validation', []) } };
  const view = render(<TaskLogs phaseLogs={logs} isSettled isExpanded onToggle={() => undefined} />);
  expect(view.container.textContent!.indexOf('a.ts')).toBeLessThan(view.container.textContent!.indexOf('intermediate activity'));
  fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }));
  expect(screen.getByText('expanded output stays visible')).toBeTruthy();
  view.rerender(<TaskLogs phaseLogs={{ ...logs, phases: { ...logs.phases, coding: phase('coding', [...entries, entry({ type: 'text', timestamp: '2026-10-25T14:42:00Z', content: 'most recent activity' })]) } }} isSettled isExpanded onToggle={() => undefined} />);
  expect(screen.getByText('expanded output stays visible')).toBeTruthy();
  expect(view.container.textContent!.indexOf('most recent activity')).toBeLessThan(view.container.textContent!.indexOf('a.ts'));
});
