/**
 * @vitest-environment jsdom
 */
/**
 * TaskClaudeRun Tests
 *
 * The Claude Code section of the task detail Overview tab, and the run helpers it uses.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../shared/i18n';
import { TaskClaudeRun } from './TaskClaudeRun';
import { buildResumeCommand, formatCostUsd, formatDurationMs, getTaskRunStep } from '../../../shared/utils/claude-run';
import type { ClaudeRunInfo } from '../../../shared/types';

const run: ClaudeRunInfo = {
  version: 1,
  sessionId: 'sess-123',
  worktreePath: '/repo/.auto-claude/worktrees/tasks/001-x',
  triage: {
    model: 'sonnet',
    effort: 'medium',
    needsPlan: true,
    scope: 'small',
    title: 'Add a button',
    reasoning: 'A small UI change',
    verification: ['npm test'],
    source: 'auto'
  },
  plan: '## Plan\n\n1. Do it',
  phases: [
    { name: 'triage', model: 'sonnet', startedAt: '2026-01-01T00:00:00Z', durationMs: 4000, costUsd: 0.0123 },
    { name: 'implement', model: 'sonnet', effort: 'medium', startedAt: '2026-01-01T00:01:00Z', isError: true, error: 'Boom' }
  ],
  validation: {
    status: 'partial',
    summary: 'Typecheck passed, one test failed',
    checks: [
      { name: 'Typecheck', command: 'npm run typecheck', passed: true },
      { name: 'Tests', command: 'npm test', passed: false, details: '1 failing' }
    ],
    findings: [{ severity: 'major', description: 'Missing null check', fixed: false }]
  },
  summary: 'Added the button',
  subagents: [{ id: 'a1', description: 'Explore the codebase', type: 'Explore', status: 'completed', startedAt: '2026-01-01T00:01:00Z' }],
  init: {
    claudeCodeVersion: '2.1.0',
    tools: [],
    agents: ['Explore'],
    skills: ['graphify'],
    slashCommands: [],
    mcpServers: [{ name: 'context7', status: 'connected' }],
    plugins: []
  },
  totalCostUsd: 0.4567,
  updatedAt: '2026-01-01T00:05:00Z'
};

describe('TaskClaudeRun', () => {
  it('shows the triage decision, validation status in text, steps and cost', () => {
    render(<TaskClaudeRun run={run} />);

    expect(screen.getByText('Sonnet · medium · plan first · small scope')).toBeInTheDocument();
    expect(screen.getByText('A small UI change')).toBeInTheDocument();
    expect(screen.getByText('Chosen by the triage run')).toBeInTheDocument();
    expect(screen.getByText('Partially passed')).toBeInTheDocument();
    expect(screen.getByText('Typecheck')).toBeInTheDocument();
    expect(screen.getByText(/Missing null check/)).toBeInTheDocument();
    expect(screen.getByText('Boom')).toBeInTheDocument();
    expect(screen.getByText('$0.4567')).toBeInTheDocument();
    expect(screen.getByText('Explore the codebase')).toBeInTheDocument();
    expect(screen.getByText('sess-123')).toBeInTheDocument();
  });

  it('keeps the plan and loaded items collapsed until opened', () => {
    render(<TaskClaudeRun run={run} />);

    expect(screen.queryByText('context7')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('What Claude Code loaded'));
    expect(screen.getByText('context7')).toBeInTheDocument();
    expect(screen.getByText('graphify')).toBeInTheDocument();
  });

  it('copies the resume command for the worktree', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<TaskClaudeRun run={run} />);
    fireEvent.click(screen.getByText('Copy resume command'));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('cd "/repo/.auto-claude/worktrees/tasks/001-x" && claude --resume sess-123')
    );
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});

describe('claude-run helpers', () => {
  it('derives the step from the execution phase and the last run step', () => {
    expect(getTaskRunStep('planning', { phases: [] })).toBe('assessing');
    expect(getTaskRunStep('planning', { phases: [{ name: 'plan', startedAt: '' }] })).toBe('planning');
    expect(getTaskRunStep('coding', { phases: [{ name: 'plan', startedAt: '' }] })).toBe('implementing');
    expect(getTaskRunStep('coding', { phases: [{ name: 'revise', startedAt: '' }] })).toBe('revising');
    expect(getTaskRunStep('qa_review')).toBe('validating');
    expect(getTaskRunStep(undefined)).toBe('idle');
  });

  it('formats cost, duration and the resume command', () => {
    expect(formatCostUsd(0.0123)).toBe('$0.0123');
    expect(formatCostUsd(0.5)).toBe('$0.50');
    expect(formatCostUsd(12.345)).toBe('$12.35');
    expect(formatDurationMs(42_000)).toBe('42s');
    expect(formatDurationMs(185_000)).toBe('3m 05s');
    expect(buildResumeCommand('abc')).toBe('claude --resume abc');
  });
});
