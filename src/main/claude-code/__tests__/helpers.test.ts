import { describe, it, expect } from 'vitest';
import { buildMcpConfig } from '../mcp-config';
import { resolveClaudeCodeTaskSettings } from '../settings';
import { applyPlanningPolicy, fixedTriage } from '../triage';
import { isClaudeRunFinished } from '../task-runner';
import { specReviewProgressDigest } from '../../spec-review-progress';
import { DEFAULT_CLAUDE_CODE_TASK_SETTINGS, type ClaudeRunInfo } from '../../../shared/types/claude-code';

describe('buildMcpConfig', () => {
  it('maps built-in and tested custom connectors to --mcp-config servers', () => {
    const config = buildMcpConfig(['context7', 'my server', 'untested'], {
      customServers: [
        { id: 'my server', name: 'My Server', type: 'http', url: 'https://example.com/mcp', verified: true },
        { id: 'untested', name: 'Untested', type: 'command', command: 'npx', verified: false },
      ],
    } as never);
    expect(Object.keys(config.mcpServers)).toEqual(['context7', 'My_Server']);
    expect(config.mcpServers.My_Server).toEqual({ type: 'http', url: 'https://example.com/mcp', headers: undefined });
  });

  it('uses the Connectors defaults when the task has no choice', () => {
    expect(Object.keys(buildMcpConfig(undefined, undefined).mcpServers)).toEqual(['context7']);
    expect(buildMcpConfig([], undefined).mcpServers).toEqual({});
  });
});

describe('resolveClaudeCodeTaskSettings', () => {
  it('fills defaults and drops invalid values', () => {
    expect(resolveClaudeCodeTaskSettings(undefined)).toEqual(DEFAULT_CLAUDE_CODE_TASK_SETTINGS);
    const resolved = resolveClaudeCodeTaskSettings({ fixedModel: 'gpt' as never, planning: 'sometimes' as never, validation: false });
    expect(resolved.fixedModel).toBe('sonnet');
    expect(resolved.planning).toBe('auto');
    expect(resolved.validation).toBe(false);
  });
});

describe('planning policy', () => {
  it('overrides the triage decision', () => {
    const base = fixedTriage(DEFAULT_CLAUDE_CODE_TASK_SETTINGS, 'T', 'fixed', '');
    expect(applyPlanningPolicy(base, { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, planning: 'always' }).needsPlan).toBe(true);
    expect(applyPlanningPolicy({ ...base, needsPlan: true }, { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, planning: 'never' }).needsPlan).toBe(false);
  });
});

describe('fixedTriage planning', () => {
  const auto = DEFAULT_CLAUDE_CODE_TASK_SETTINGS;
  it('plans after a failed triage when the policy is auto', () => {
    expect(fixedTriage({ ...auto, planning: 'auto' }, 'T', 'fallback', '').needsPlan).toBe(true);
  });
  it('respects explicit policies and fixed triage', () => {
    expect(fixedTriage({ ...auto, planning: 'never' }, 'T', 'fallback', '').needsPlan).toBe(false);
    expect(fixedTriage({ ...auto, planning: 'always' }, 'T', 'fallback', '').needsPlan).toBe(true);
    expect(fixedTriage({ ...auto, planning: 'auto' }, 'T', 'fixed', '').needsPlan).toBe(false);
  });
});

describe('isClaudeRunFinished', () => {
  const run = (phases: Array<Record<string, unknown>>) => ({ version: 1 as const, phases, subagents: [], totalCostUsd: 0, updatedAt: '' }) as never;
  const done = { startedAt: 'a', endedAt: 'b' };

  it('is finished after a successful validation, or implementation when validation is off', () => {
    expect(isClaudeRunFinished(run([{ name: 'implement', ...done }, { name: 'validate', ...done }]), true)).toBe(true);
    expect(isClaudeRunFinished(run([{ name: 'implement', ...done }]), true)).toBe(false);
    expect(isClaudeRunFinished(run([{ name: 'implement', ...done }]), false)).toBe(true);
  });

  it('is not finished when the last step failed or is still running', () => {
    expect(isClaudeRunFinished(run([{ name: 'validate', ...done, isError: true }]), true)).toBe(false);
    expect(isClaudeRunFinished(run([{ name: 'validate', startedAt: 'a' }]), true)).toBe(false);
    expect(isClaudeRunFinished(null, true)).toBe(false);
  });

  it('keeps a completed spec audit resumable until canonical progress is published', () => {
    const reviewedAt = '2026-10-30T10:00:00Z';
    const context = { specId: '123-review', baseBranch: 'main' };
    const info: ClaudeRunInfo = { version: 1, phases: [{ name: 'spec_review', ...done, endedAt: reviewedAt }],
      subagents: [], totalCostUsd: 0, updatedAt: '',
      specReview: { complete: false, checksObserved: false, summary: 'Checks unobserved', sections: [], gaps: [] },
    };
    expect(isClaudeRunFinished(info, true, context)).toBe(false);
    const reportDigest = specReviewProgressDigest({ taskId: context.specId, reviewedAt, report: info.specReview! });
    info.specReviewProgress = { commit: 'a'.repeat(40), branch: 'main', reportDigest, reviewedAt, changed: true };
    expect(isClaudeRunFinished(info, true, context)).toBe(true);
    expect(isClaudeRunFinished(info, true)).toBe(false);
    expect(isClaudeRunFinished(info, true, { ...context, baseBranch: 'other' })).toBe(false);
    info.specReview = { ...info.specReview!, summary: 'Changed findings' };
    expect(isClaudeRunFinished(info, true, context)).toBe(false);
  });

  it('does not reset a newly accepted reviewer request before its next phase is recorded', () => {
    const info: ClaudeRunInfo = { version: 1, phases: [{ name: 'validate', startedAt: 'a', endedAt: 'b' }],
      subagents: [], totalCostUsd: 0, updatedAt: '', revisionRequest: {
        id: 'request', requestedAt: 'now', feedback: 'Apply this correction', feedbackAttachments: [], phaseStart: 1,
      } };
    expect(isClaudeRunFinished(info, true)).toBe(false);
    info.revisionRequest!.settledAt = 'done';
    expect(isClaudeRunFinished(info, true)).toBe(true);
    info.revisionRequest!.settledAt = undefined;
    info.revisionRequest!.supersededAt = 'superseded';
    expect(isClaudeRunFinished(info, true)).toBe(true);
  });
});
