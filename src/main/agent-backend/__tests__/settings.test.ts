import { describe, expect, it, vi } from 'vitest';
vi.mock('../../settings-utils', () => ({ readSettingsFile: () => undefined }));
import { resolveAgentBackendSettings } from '../settings';
import type { AgentBackendSettings } from '../../../shared/types/agent-backend';

describe('task advisor schedule settings', () => {
  it('defaults old and malformed settings to phase boundaries', () => {
    expect(resolveAgentBackendSettings(undefined).omp.advisorSchedule).toBe('phase-boundaries');
    expect(resolveAgentBackendSettings({ omp: { advisorSchedule: 'invalid' } } as unknown as Partial<AgentBackendSettings>).omp.advisorSchedule).toBe('phase-boundaries');
  });

  it.each(['continuous', 'phase-boundaries', 'off'] as const)('preserves explicit %s schedule and other OMP settings', (advisorSchedule) => {
    expect(resolveAgentBackendSettings({ omp: { advisorSchedule, command: '/my/omp', models: { sonnet: 'local/model' } } } as Partial<AgentBackendSettings>).omp).toMatchObject({
      advisorSchedule, command: '/my/omp', models: { sonnet: 'local/model' },
    });
  });
});
