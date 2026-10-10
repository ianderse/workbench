/**
 * Claude Code inventory
 * =====================
 *
 * Lists what Claude Code loads when it runs a task in a project: subagents, skills, slash
 * commands, hooks, MCP servers, CLAUDE.md memory files and settings files, from the user's
 * Claude config dir and the project's `.claude/`. Read-only and async.
 */

import { readdir, readFile, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ClaudeCodeInventory, ClaudeCodeInventoryItem } from '../../shared/types/claude-code';

type Scope = ClaudeCodeInventoryItem['scope'];

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Frontmatter `name` and `description` of a Markdown file */
async function readFrontmatter(file: string): Promise<{ name?: string; description?: string }> {
  try {
    const text = await readFile(file, 'utf-8');
    if (!text.startsWith('---')) return {};
    const end = text.indexOf('\n---', 3);
    if (end === -1) return {};
    const block = text.slice(3, end);
    const field = (key: string) => {
      const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return match ? match[1].trim().replace(/^["']|["']$/g, '') : undefined;
    };
    return { name: field('name'), description: field('description') };
  } catch {
    return {};
  }
}

/** Markdown files under a directory (recursive), e.g. `.claude/agents` */
async function listMarkdown(dir: string, scope: Scope): Promise<ClaudeCodeInventoryItem[]> {
  const items: ClaudeCodeInventoryItem[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return items;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      items.push(...(await listMarkdown(full, scope)));
    } else if (entry.name.endsWith('.md')) {
      const meta = await readFrontmatter(full);
      items.push({ name: meta.name || entry.name.replace(/\.md$/, ''), description: meta.description, scope, path: full });
    }
  }
  return items;
}

/** Skill directories (`<dir>/<skill>/SKILL.md`) */
async function listSkills(dir: string, scope: Scope): Promise<ClaudeCodeInventoryItem[]> {
  const items: ClaudeCodeInventoryItem[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return items;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    if (!(await exists(skillFile))) continue;
    const meta = await readFrontmatter(skillFile);
    items.push({ name: meta.name || entry.name, description: meta.description, scope, path: skillFile });
  }
  return items;
}

/** Hook events configured in a settings file */
function hooksFromSettings(settings: Record<string, unknown> | null, scope: Scope, file: string): ClaudeCodeInventoryItem[] {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  const items: ClaudeCodeInventoryItem[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups as Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>) {
      const count = Array.isArray(group.hooks) ? group.hooks.length : 0;
      items.push({
        name: group.matcher ? `${event} (${group.matcher})` : event,
        description: `${count} handler${count === 1 ? '' : 's'}${group.hooks?.[0]?.command ? `: ${group.hooks[0].command}` : ''}`,
        scope,
        path: file,
      });
    }
  }
  return items;
}

function mcpFromConfig(config: Record<string, unknown> | null, scope: Scope, file: string): ClaudeCodeInventoryItem[] {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers as Record<string, { type?: string; command?: string; url?: string }>).map(([name, entry]) => ({
    name,
    description: entry?.url ?? [entry?.command].filter(Boolean).join(' '),
    scope,
    path: file,
  }));
}

/** The user's Claude config dir (CLAUDE_CONFIG_DIR of the profile, or ~/.claude) */
export function getUserClaudeDir(configDir?: string): string {
  return configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Scan what Claude Code loads for a project */
export async function getClaudeCodeInventory(projectPath: string, configDir?: string): Promise<ClaudeCodeInventory> {
  const userDir = getUserClaudeDir(configDir);
  const projectDir = path.join(projectPath, '.claude');

  const settingsFiles: Array<{ file: string; scope: Scope }> = [
    { file: path.join(userDir, 'settings.json'), scope: 'user' },
    { file: path.join(projectDir, 'settings.json'), scope: 'project' },
    { file: path.join(projectDir, 'settings.local.json'), scope: 'project' },
  ];
  const settings = await Promise.all(settingsFiles.map(async (s) => ({ ...s, json: await readJson(s.file) })));

  const userConfigFile = configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
  const userConfig = await readJson(userConfigFile);
  const projectEntry = (userConfig?.projects as Record<string, Record<string, unknown>> | undefined)?.[projectPath] ?? null;
  const projectMcpFile = path.join(projectPath, '.mcp.json');

  const memoryCandidates: Array<{ file: string; scope: Scope; name: string }> = [
    { file: path.join(userDir, 'CLAUDE.md'), scope: 'user', name: '~/.claude/CLAUDE.md' },
    { file: path.join(projectPath, 'CLAUDE.md'), scope: 'project', name: 'CLAUDE.md' },
    { file: path.join(projectDir, 'CLAUDE.md'), scope: 'project', name: '.claude/CLAUDE.md' },
    { file: path.join(projectPath, 'CLAUDE.local.md'), scope: 'project', name: 'CLAUDE.local.md' },
  ];

  const [userAgents, projectAgents, userSkills, projectSkills, userCommands, projectCommands, projectMcp, memoryFiles] = await Promise.all([
    listMarkdown(path.join(userDir, 'agents'), 'user'),
    listMarkdown(path.join(projectDir, 'agents'), 'project'),
    listSkills(path.join(userDir, 'skills'), 'user'),
    listSkills(path.join(projectDir, 'skills'), 'project'),
    listMarkdown(path.join(userDir, 'commands'), 'user'),
    listMarkdown(path.join(projectDir, 'commands'), 'project'),
    readJson(projectMcpFile),
    Promise.all(memoryCandidates.map(async (m) => ((await exists(m.file)) ? m : null))),
  ]);

  return {
    agents: [...projectAgents, ...userAgents],
    skills: [...projectSkills, ...userSkills],
    commands: [...projectCommands, ...userCommands],
    hooks: settings.flatMap((s) => hooksFromSettings(s.json, s.scope, s.file)),
    mcpServers: [
      ...mcpFromConfig(projectMcp, 'project', projectMcpFile),
      ...mcpFromConfig(projectEntry, 'project', userConfigFile),
      ...mcpFromConfig(userConfig, 'user', userConfigFile),
    ],
    memoryFiles: memoryFiles
      .filter((m): m is (typeof memoryCandidates)[number] => m !== null)
      .map((m) => ({ name: m.name, scope: m.scope, path: m.file })),
    settingsFiles: settings
      .filter((s) => s.json !== null)
      .map((s) => ({ name: path.relative(s.scope === 'user' ? path.dirname(userDir) : projectPath, s.file), scope: s.scope, path: s.file })),
  };
}
