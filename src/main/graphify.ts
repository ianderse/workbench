/**
 * Graphify (https://github.com/Graphify-Labs/graphify) builds a knowledge graph of a project's code.
 *
 * Auto Claude detects the `graphify` CLI (Settings > Updates), sets up its /graphify command in
 * Claude Code, builds each project's memory graph into .auto-claude/memory (Settings > Project >
 * Memory index), and gives agents a CodebaseGraph tool to search it when the project's "Use
 * Graphify" setting is on. Everything runs asynchronously so the main process never blocks on the
 * CLI.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import semver from 'semver';
import { findExecutableAsync, getAugmentedEnvAsync } from './env-utils';
import { isWindows, requiresShell } from './platform';
import { appLog } from './app-logger';
import { getClaudeProfileManager } from './claude-profile-manager';
import { expandHomePath } from './claude-profile/profile-utils';
import { getGraphifyGraphPath, getGraphifyMemoryDir, hasGraphifyGraph } from './graphify-paths';
import type { GraphifyGraph, GraphifyIndexInfo, GraphifyVersionInfo } from '../shared/types/cli';

const execFileAsync = promisify(execFile);

/** PyPI package that provides the `graphify` command */
const GRAPHIFY_PACKAGE = 'graphifyy';
const PYPI_URL = `https://pypi.org/pypi/${GRAPHIFY_PACKAGE}/json`;
const VERSION_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const INDEX_INFO_FILE = 'index.json';
/** How long to wait for an install started from Settings > Updates before setting up /graphify */
const INSTALL_WATCH_INTERVAL_MS = 5000;
const INSTALL_WATCH_MAX_TRIES = 120;

interface GraphifyInstallation {
  path: string;
  version: string | null;
}

let detection: Promise<GraphifyInstallation | null> | null = null;
let latestVersion: Promise<string | null> | null = null;
const buildsInProgress = new Map<string, Promise<GraphifyIndexInfo>>();

export { getGraphifyMemoryDir, getGraphifyGraphPath, hasGraphifyGraph };

async function runGraphify(
  executable: string,
  args: string[],
  cwd?: string,
  timeout = VERSION_TIMEOUT_MS,
  extraEnv: Record<string, string | undefined> = {}
) {
  const env: Record<string, string | undefined> = { ...(await getAugmentedEnvAsync()), ...extraEnv };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return execFileAsync(executable, args, {
    cwd,
    env: env as NodeJS.ProcessEnv,
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    shell: requiresShell(executable),
  });
}

async function detect(): Promise<GraphifyInstallation | null> {
  const executable = await findExecutableAsync('graphify');
  if (!executable) return null;
  try {
    const { stdout } = await runGraphify(executable, ['--version']);
    return { path: executable, version: stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? null };
  } catch (error) {
    appLog.warn('[Graphify] Version check failed:', error);
    return { path: executable, version: null };
  }
}

/** The installed graphify command; detected once and cached until a forced refresh */
export function detectGraphify(forceRefresh = false): Promise<GraphifyInstallation | null> {
  if (forceRefresh || !detection) detection = detect();
  return detection;
}

async function fetchLatest(): Promise<string | null> {
  try {
    const response = await fetch(PYPI_URL, { signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
    if (!response.ok) return null;
    const data = (await response.json()) as { info?: { version?: string } };
    return data.info?.version ?? null;
  } catch (error) {
    appLog.warn('[Graphify] Could not fetch the latest version:', error);
    return null;
  }
}

/** Installed and latest Graphify versions */
export async function checkGraphifyVersion(forceRefresh = false): Promise<GraphifyVersionInfo> {
  if (forceRefresh || !latestVersion) latestVersion = fetchLatest();
  const [installation, latest] = await Promise.all([detectGraphify(forceRefresh), latestVersion]);
  const installed = installation ? installation.version ?? 'unknown' : null;
  const isOutdated = !!(installed && latest && semver.valid(installed) && semver.valid(latest) && semver.lt(installed, latest));
  const claudeCommand = installation ? await getGraphifyClaudeCommandStatus() : null;
  return { installed, latest, isOutdated, claudeCommand };
}

/**
 * Claude Code config directories that should offer /graphify: the default one (~/.claude) and each
 * Claude profile's own (Claude Code runs with CLAUDE_CONFIG_DIR set to it)
 */
function getClaudeConfigDirs(): string[] {
  const dirs = [path.join(os.homedir(), '.claude')];
  try {
    for (const profile of getClaudeProfileManager().getSettings().profiles) {
      if (profile.configDir) dirs.push(path.resolve(expandHomePath(profile.configDir)));
    }
  } catch (error) {
    appLog.warn('[Graphify] Could not read the Claude profiles:', error);
  }
  return [...new Set(dirs)];
}

/** Where `graphify install` puts the /graphify skill in a Claude Code config directory */
function getClaudeSkillPath(configDir: string): string {
  return path.join(configDir, 'skills', 'graphify', 'SKILL.md');
}

/** Claude Code config directories that don't have the /graphify command yet */
async function getConfigDirsMissingCommand(): Promise<{ dirs: string[]; missing: string[] }> {
  const dirs = getClaudeConfigDirs();
  const present = await Promise.all(
    dirs.map((dir) => fs.access(getClaudeSkillPath(dir)).then(() => true, () => false))
  );
  return { dirs, missing: dirs.filter((_, i) => !present[i]) };
}

/** Whether Claude Code offers /graphify, counted over its config directories */
export async function getGraphifyClaudeCommandStatus(): Promise<{ configDirs: number; missing: number }> {
  const { dirs, missing } = await getConfigDirsMissingCommand();
  return { configDirs: dirs.length, missing: missing.length };
}

/**
 * Make /graphify available in Claude Code: `graphify install` copies Graphify's skill into each
 * config directory that lacks it (and registers it in that directory's CLAUDE.md)
 */
export async function installGraphifyClaudeCommand(): Promise<{ configDirs: number; missing: number }> {
  const installation = await detectGraphify();
  if (!installation) throw new Error('Graphify is not installed');
  const defaultDir = path.join(os.homedir(), '.claude');
  const { dirs, missing } = await getConfigDirsMissingCommand();
  const failed: string[] = [];
  for (const dir of missing) {
    try {
      await runGraphify(installation.path, ['install', '--platform', 'claude'], os.homedir(), VERSION_TIMEOUT_MS * 4, {
        // The default directory is used when CLAUDE_CONFIG_DIR isn't set
        CLAUDE_CONFIG_DIR: dir === defaultDir ? undefined : dir,
        PYTHONIOENCODING: 'utf-8',
      });
    } catch (error) {
      failed.push(dir);
      appLog.warn(`[Graphify] Could not add /graphify to Claude Code in ${dir}:`, error);
    }
  }
  if (failed.length === missing.length && failed.length > 0) {
    throw new Error('Could not add the /graphify command to Claude Code');
  }
  return { configDirs: dirs.length, missing: failed.length };
}

let installWatch: ReturnType<typeof setTimeout> | null = null;

/**
 * After an install or update opens in a terminal, wait (in the background) for the new graphify
 * command and then make /graphify available in Claude Code
 */
export function setUpClaudeCommandAfterInstall(previousVersion: string | null): void {
  if (installWatch) clearTimeout(installWatch);
  let tries = 0;
  const check = async () => {
    installWatch = null;
    tries++;
    const installation = await detectGraphify(true);
    if (installation && (previousVersion === null || installation.version !== previousVersion)) {
      try {
        await installGraphifyClaudeCommand();
        appLog.info('[Graphify] Added the /graphify command to Claude Code');
      } catch (error) {
        appLog.warn('[Graphify] Setting up /graphify after the install failed:', error);
      }
      return;
    }
    if (tries < INSTALL_WATCH_MAX_TRIES) installWatch = setTimeout(() => void check(), INSTALL_WATCH_INTERVAL_MS);
  };
  installWatch = setTimeout(() => void check(), INSTALL_WATCH_INTERVAL_MS);
}

/** Shell command that installs (or updates) Graphify with uv, pipx or pip, whichever is available */
export async function getGraphifyInstallCommand(isUpdate: boolean): Promise<string> {
  if (await findExecutableAsync('uv')) {
    return isUpdate ? `uv tool upgrade ${GRAPHIFY_PACKAGE}` : `uv tool install ${GRAPHIFY_PACKAGE}`;
  }
  if (await findExecutableAsync('pipx')) {
    return isUpdate ? `pipx upgrade ${GRAPHIFY_PACKAGE}` : `pipx install ${GRAPHIFY_PACKAGE}`;
  }
  const python = isWindows() ? 'py' : 'python3';
  return `${python} -m pip install --user --upgrade ${GRAPHIFY_PACKAGE}`;
}

/** The project's memory graph, trimmed to what the graph view draws, or null when it has none */
export async function readGraphifyGraph(projectPath: string): Promise<GraphifyGraph | null> {
  let raw: string;
  try {
    raw = await fs.readFile(getGraphifyGraphPath(projectPath), 'utf-8');
  } catch {
    return null;
  }
  const data = JSON.parse(raw) as {
    nodes?: Array<{ id: string; label?: string; community?: number; source_file?: string; source_location?: string }>;
    links?: Array<{ source: string; target: string; relation?: string }>;
    edges?: Array<{ source: string; target: string; relation?: string }>;
  };
  const nodes = (data.nodes ?? []).map((node) => ({
    id: String(node.id),
    label: node.label ?? String(node.id),
    community: node.community,
    sourceFile: node.source_file,
    sourceLocation: node.source_location,
  }));
  const ids = new Set(nodes.map((node) => node.id));
  const links = (data.links ?? data.edges ?? [])
    .map((link) => ({ source: String(link.source), target: String(link.target), relation: link.relation }))
    .filter((link) => ids.has(link.source) && ids.has(link.target) && link.source !== link.target);
  return { nodes, links };
}

/** The project's memory graph, or null when it has not been built */
export async function readGraphifyIndex(projectPath: string): Promise<GraphifyIndexInfo | null> {
  try {
    await fs.access(getGraphifyGraphPath(projectPath));
    const raw = await fs.readFile(path.join(getGraphifyMemoryDir(projectPath), INDEX_INFO_FILE), 'utf-8');
    return JSON.parse(raw) as GraphifyIndexInfo;
  } catch {
    return null;
  }
}

async function build(projectPath: string): Promise<GraphifyIndexInfo> {
  const installation = await detectGraphify();
  if (!installation) throw new Error('Graphify is not installed');

  const memoryDir = getGraphifyMemoryDir(projectPath);
  await fs.mkdir(memoryDir, { recursive: true });

  // Code-only extraction parses the code locally (tree-sitter), so no API key is needed
  const { stdout, stderr } = await runGraphify(
    installation.path,
    ['extract', projectPath, '--code-only', '--out', memoryDir],
    projectPath,
    BUILD_TIMEOUT_MS
  );
  const output = `${stdout}\n${stderr}`;
  const stats = output.match(/(\d+) nodes, (\d+) edges(?:, (\d+) communities)?/);

  // A readable summary for agents (GRAPH_REPORT.md), without naming communities through an LLM
  try {
    await runGraphify(installation.path, ['cluster-only', memoryDir, '--no-label', '--no-viz'], projectPath, BUILD_TIMEOUT_MS);
  } catch (error) {
    appLog.warn('[Graphify] Could not write the graph report:', error);
  }

  const info: GraphifyIndexInfo = {
    nodes: stats ? Number(stats[1]) : 0,
    edges: stats ? Number(stats[2]) : 0,
    communities: stats?.[3] ? Number(stats[3]) : 0,
    builtAt: new Date().toISOString(),
    version: installation.version,
  };
  await fs.writeFile(path.join(memoryDir, INDEX_INFO_FILE), JSON.stringify(info, null, 2));
  return info;
}

/** Build (or rebuild) the project's memory graph; a build already running for it is reused */
export function buildGraphifyIndex(projectPath: string): Promise<GraphifyIndexInfo> {
  const running = buildsInProgress.get(projectPath);
  if (running) return running;
  const promise = build(projectPath).finally(() => buildsInProgress.delete(projectPath));
  buildsInProgress.set(projectPath, promise);
  return promise;
}

/**
 * Prompt section that points an agent at the project's memory graph, or null when the project
 * doesn't use Graphify or has no graph yet
 */
export async function getGraphifyPromptContext(projectPath: string): Promise<string | null> {
  const [installation, index] = await Promise.all([detectGraphify(), readGraphifyIndex(projectPath)]);
  if (!installation || !index) return null;
  const graph = getGraphifyGraphPath(projectPath);
  const report = path.join(path.dirname(graph), 'GRAPH_REPORT.md');
  const cli = installation.path.includes(' ') ? `"${installation.path}"` : installation.path;
  return [
    '## PROJECT MEMORY GRAPH (GRAPHIFY)',
    '',
    `A knowledge graph of this project's code (${index.nodes} nodes, ${index.edges} edges) is available.`,
    `Read the summary in \`${report}\` for the main modules and most connected symbols, and query the graph`,
    'to see how code connects before searching through files:',
    '',
    `- \`${cli} query "<question>" --graph "${graph}"\``,
    `- \`${cli} explain "<SymbolName>" --graph "${graph}"\``,
    `- \`${cli} path "<SymbolA>" "<SymbolB>" --graph "${graph}"\``,
    `- \`${cli} affected "<SymbolName>" --graph "${graph}"\` (what a change to it can impact)`,
    '',
    `The graph was built ${index.builtAt}; code changed since then is not in it, so confirm details in the files.`,
  ].join('\n');
}
