/**
 * Triage decides model, effort, planning and the commands that verify a task. The commands
 * are run as the task's checks, so a script the project does not define must not survive
 * triage: it would otherwise be reported as a check that passed while it only printed
 * "Missing script".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DEFAULT_CLAUDE_CODE_TASK_SETTINGS } from '../../../shared/types/claude-code';

const runClaudeTextMock = vi.fn();
vi.mock('../run-text', () => ({
  runClaudeText: (...args: unknown[]) => runClaudeTextMock(...args),
  READ_ONLY_TOOLS: ['Read'],
}));

import { triageTask } from '../triage';

let cwd: string;

function triageReturns(verification: string[]): void {
  runClaudeTextMock.mockResolvedValue({
    structured: {
      model: 'sonnet',
      effort: 'medium',
      needsPlan: false,
      scope: 'small',
      title: 'Cache the branch list',
      reasoning: 'Small change in one hook',
      verification,
    },
    costUsd: 0.01,
  });
}

async function verificationFor(verification: string[]): Promise<string[]> {
  triageReturns(verification);
  const { triage } = await triageTask({
    description: 'Cache the branch list between dialog opens',
    cwd,
    settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS },
  });
  return triage.verification;
}

beforeEach(() => {
  runClaudeTextMock.mockReset();
  cwd = mkdtempSync(path.join(tmpdir(), 'triage-'));
  writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: 'project', scripts: { test: 'vitest run', build: 'vite build' } }),
  );
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('triageTask verification commands', () => {
  it('drops an npm script the project does not define', async () => {
    expect(await verificationFor(['npm run typecheck', 'npm run test'])).toEqual(['npm run test']);
  });

  it('keeps commands that are not package scripts', async () => {
    const commands = ['npx vitest run src/a.test.ts', 'make check', 'pytest -q'];
    expect(await verificationFor(commands)).toEqual(commands);
  });

  it('checks yarn, pnpm and bun scripts the same way', async () => {
    expect(await verificationFor(['yarn run lint', 'pnpm run build', 'bun run test'])).toEqual([
      'pnpm run build',
      'bun run test',
    ]);
  });

  it('keeps a script run in a workspace, which the root package.json does not define', async () => {
    const commands = ['npm run -w pkg test', 'npm run --workspace=pkg lint', 'npm run --workspaces check'];
    expect(await verificationFor(commands)).toEqual(commands);
  });

  it('leaves the commands alone when the project has no package.json', async () => {
    rmSync(path.join(cwd, 'package.json'));
    expect(await verificationFor(['npm run typecheck'])).toEqual(['npm run typecheck']);
  });
});
