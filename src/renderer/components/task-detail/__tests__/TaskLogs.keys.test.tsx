/**
 * @vitest-environment jsdom
 */
/**
 * OMP batches tool calls: one reply can read two files, so its tool rows share a timestamp and a
 * tool name. Their React keys must still be unique (a duplicate key can drop or repeat log rows).
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
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
