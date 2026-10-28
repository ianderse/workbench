import { describe, expect, it } from 'vitest';
import { resolveClaudeCodeTaskSettings } from '../settings';
import type { ClaudeCodeTaskSettings } from '../../../shared/types/claude-code';

describe('task throughput settings', () => {
  it('gives older settings the safe phase-boundary defaults', () => {
    expect(resolveClaudeCodeTaskSettings(undefined)).toMatchObject({
      freshContext: 'before-validation', stallRecovery: 'recover',
    });
  });

  it('preserves explicit opt-outs and rejects malformed stored values', () => {
    expect(resolveClaudeCodeTaskSettings({ freshContext: 'off', stallRecovery: 'off' })).toMatchObject({
      freshContext: 'off', stallRecovery: 'off',
    });
    expect(resolveClaudeCodeTaskSettings({ freshContext: 'invalid', stallRecovery: null } as unknown as Partial<ClaudeCodeTaskSettings>)).toMatchObject({
      freshContext: 'before-validation', stallRecovery: 'recover',
    });
  });
});
