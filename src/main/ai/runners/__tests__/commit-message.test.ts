import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockRunClaudeText = vi.fn();
vi.mock('../../../claude-code/run-text', () => ({
  runClaudeText: (...args: unknown[]) => mockRunClaudeText(...args),
}));

import { generateCommitMessage } from '../commit-message';

let specDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  specDir = mkdtempSync(join(tmpdir(), 'commit-message-'));
});

afterEach(() => rmSync(specDir, { recursive: true, force: true }));

describe('generateCommitMessage', () => {
  it('returns the trimmed message from Claude Code', async () => {
    mockRunClaudeText.mockResolvedValue({ text: '  feat(auth): add login\n\nAdd a login page.  ' });
    const message = await generateCommitMessage({ specName: '001-login', taskTitle: 'Add login' });
    expect(message).toBe('feat(auth): add login\n\nAdd a login page.');
  });

  it('runs haiku without tools and lets the model pick the type', async () => {
    mockRunClaudeText.mockResolvedValue({ text: 'fix: x' });
    await generateCommitMessage({
      specName: '001-login',
      taskTitle: 'Add login',
      taskDescription: 'Users need a login page',
      diffSummary: ' src/login.ts | 10 +++',
      filesChanged: ['src/login.ts'],
    });
    const options = mockRunClaudeText.mock.calls[0][0];
    expect(options.model).toBe('haiku');
    expect(options.tools).toBeUndefined();
    expect(options.prompt).toContain('Task: Add login');
    expect(options.prompt).toContain('Users need a login page');
    expect(options.prompt).toContain('src/login.ts');
    expect(options.prompt).not.toContain('Type:');
  });

  it('includes the Claude Code run summary when the task has one', async () => {
    writeFileSync(join(specDir, 'claude_run.json'), JSON.stringify({
      phases: [], subagents: [], totalCostUsd: 0, updatedAt: '', summary: 'Added the login form and route',
    }));
    mockRunClaudeText.mockResolvedValue({ text: 'feat: login' });
    await generateCommitMessage({ specName: '001-login', specDir });
    expect(mockRunClaudeText.mock.calls[0][0].prompt).toContain('Added the login form and route');
  });

  it('asks for a Fixes line when an issue is linked', async () => {
    mockRunClaudeText.mockResolvedValue({ text: 'fix: x\n\nFixes #42' });
    await generateCommitMessage({ specName: '001', githubIssue: 42 });
    expect(mockRunClaudeText.mock.calls[0][0].prompt).toContain("Fixes #42");
  });

  it('falls back to a chore message when the run fails or is empty', async () => {
    mockRunClaudeText.mockRejectedValueOnce(new Error('not signed in'));
    expect(await generateCommitMessage({ specName: '001-login', taskTitle: 'Add login', githubIssue: 7 }))
      .toBe('chore: Add login\n\nFixes #7');

    mockRunClaudeText.mockResolvedValueOnce({ text: '' });
    expect(await generateCommitMessage({ specName: '001-login' })).toBe('chore: 001-login');
  });
});
