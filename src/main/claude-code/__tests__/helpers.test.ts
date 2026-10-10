import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildMcpConfig } from '../mcp-config';
import { resolveClaudeCodeTaskSettings } from '../settings';
import { getClaudeCodeInventory } from '../inventory';
import { applyPlanningPolicy, fixedTriage } from '../triage';
import { DEFAULT_CLAUDE_CODE_TASK_SETTINGS } from '../../../shared/types/claude-code';

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
    const resolved = resolveClaudeCodeTaskSettings({ fixedModel: 'gpt' as never, planning: 'sometimes' as never, maxBudgetUsd: 3 });
    expect(resolved.fixedModel).toBe('sonnet');
    expect(resolved.planning).toBe('auto');
    expect(resolved.maxBudgetUsd).toBe(3);
  });
});

describe('planning policy', () => {
  it('overrides the triage decision', () => {
    const base = fixedTriage(DEFAULT_CLAUDE_CODE_TASK_SETTINGS, 'T', 'fixed', '');
    expect(applyPlanningPolicy(base, { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, planning: 'always' }).needsPlan).toBe(true);
    expect(applyPlanningPolicy({ ...base, needsPlan: true }, { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, planning: 'never' }).needsPlan).toBe(false);
  });
});

describe('getClaudeCodeInventory', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lists agents, skills, hooks, MCP servers and memory files', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'inv-'));
    const project = path.join(root, 'project');
    const userDir = path.join(root, 'user');
    mkdirSync(path.join(project, '.claude', 'agents'), { recursive: true });
    mkdirSync(path.join(project, '.claude', 'skills', 'deploy'), { recursive: true });
    mkdirSync(userDir, { recursive: true });
    writeFileSync(path.join(project, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews code\n---\nBody');
    writeFileSync(path.join(project, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\ndescription: Deploy it\n---\n');
    writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh' }] }] } }));
    writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db-server' } } }));
    writeFileSync(path.join(project, 'CLAUDE.md'), '# Rules');

    const inventory = await getClaudeCodeInventory(project, userDir);
    expect(inventory.agents).toEqual([expect.objectContaining({ name: 'reviewer', description: 'Reviews code', scope: 'project' })]);
    expect(inventory.skills).toEqual([expect.objectContaining({ name: 'deploy', description: 'Deploy it' })]);
    expect(inventory.hooks[0].name).toBe('PreToolUse (Bash)');
    expect(inventory.mcpServers).toEqual([expect.objectContaining({ name: 'db', description: 'db-server' })]);
    expect(inventory.memoryFiles.map((m) => m.name)).toEqual(['CLAUDE.md']);
  });
});
