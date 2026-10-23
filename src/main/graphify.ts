/**
 * Graphify (https://github.com/Graphify-Labs/graphify) builds a knowledge graph of a project's code.
 *
 * Workbench detects the `graphify` CLI (Settings > Updates), sets up its /graphify command in
 * Claude Code, builds each project's memory graph into .workbench/knowledge (Settings > Project >
 * Knowledge index), and gives agents a CodebaseGraph tool to search it when the project uses
 * Graphify (its "Use Graphify" switch, which is on while .workbench/knowledge exists). Everything runs asynchronously so the main process never blocks on the
 * CLI.
 */

import path from 'path';
import { promises as fs } from 'fs';
import semver from 'semver';
import { findExecutableAsync, getAugmentedEnvAsync } from './env-utils';
import { isWindows } from './platform';
import { appLog } from './app-logger';
import { getWslInfo, isWslRuntime, toRuntimePath, whenShellRuntimeReady } from './platform/shell-runtime';
import { runTool } from './platform/runtime-exec';
import { execInWsl } from './platform/wsl-exec-basic';
import { isUnderMountRoot } from './platform/wsl-detect';
import { getClaudeHome, joinClaudeHome } from './platform/claude-home';
import { getClaudeProfileManager } from './claude-profile-manager';
import { expandHomePath } from './claude-profile/profile-utils';
import { getGraphifyGraphPath, getGraphifyMemoryDir, getGraphifyOutDir, hasGraphifyGraph, isGraphifyEnabled } from './graphify-paths';
import type { GraphifyGraph, GraphifyIndexInfo, GraphifyVersionInfo } from '../shared/types/cli';
import { formatDateTime } from '../shared/utils/format-date-time';

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
/** Stops a project's running build (when Use Graphify is switched off) */
const buildAborts = new Map<string, AbortController>();

export { hasGraphifyGraph, isGraphifyEnabled };

/**
 * Run graphify through the runtime layer: natively the installed command (Windows shims through
 * a shell), in WSL the distribution's graphify with path arguments and cwd translated and
 * GRAPHIFY_OUT / CLAUDE_CONFIG_DIR sent as Linux paths
 */
async function runGraphify(
  executable: string,
  args: string[],
  cwd?: string,
  timeout = VERSION_TIMEOUT_MS,
  extraEnv: Record<string, string | undefined> = {},
  signal?: AbortSignal
) {
  await whenShellRuntimeReady();
  // In WSL the app's own environment stays on Windows (the runtime layer sends what is added)
  const baseEnv = isWslRuntime() ? { ...process.env } : await getAugmentedEnvAsync();
  const env: Record<string, string | undefined> = { ...baseEnv, ...extraEnv };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return runTool('python', args, {
    command: executable,
    cwd,
    env: env as NodeJS.ProcessEnv,
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    signal,
  });
}

/** `command -v <name>` inside WSL (login PATH), ignoring Windows programs on the appended Windows PATH */
async function findInWsl(name: string): Promise<string | null> {
  const wsl = getWslInfo();
  if (!wsl) return null;
  try {
    const { stdout } = await execInWsl('/bin/sh', ['-c', 'command -v "$1"', 'sh', name]);
    const found = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
    return found.startsWith('/') && !isUnderMountRoot(found, wsl.mountRoot) ? found : null;
  } catch {
    return null;
  }
}

/** The graphify command: in WSL the distribution's own (looked up again, it may have been installed since startup) */
async function findGraphify(): Promise<string | null> {
  await whenShellRuntimeReady();
  if (isWslRuntime()) return findInWsl('graphify');
  return findExecutableAsync('graphify');
}

async function detect(): Promise<GraphifyInstallation | null> {
  const executable = await findGraphify();
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
  return { installed, latest, isOutdated };
}

/**
 * Claude Code config directories that should offer /graphify: the default one (~/.claude) and each
 * Claude profile's own (Claude Code runs with CLAUDE_CONFIG_DIR set to it)
 */
function getClaudeConfigDirs(): string[] {
  // In WSL Claude Code keeps its config in the Linux home (a UNC path from Windows)
  const dirs = [joinClaudeHome('.claude')];
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

/**
 * Make /graphify available in Claude Code: `graphify install` copies Graphify's skill into each
 * config directory that lacks it (and registers it in that directory's CLAUDE.md)
 */
async function installGraphifyClaudeCommand(): Promise<{ configDirs: number; missing: number }> {
  const installation = await detectGraphify();
  if (!installation) throw new Error('Graphify is not installed');
  const defaultDir = joinClaudeHome('.claude');
  const { dirs, missing } = await getConfigDirsMissingCommand();
  const failed: string[] = [];
  for (const dir of missing) {
    try {
      await runGraphify(installation.path, ['install', '--platform', 'claude'], getClaudeHome(), VERSION_TIMEOUT_MS * 4, {
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

/**
 * Shell command that installs (or updates) Graphify with uv, pipx or pip, whichever is available
 * (inside WSL when the app runs its tools there: the command then runs in a WSL terminal)
 */
export async function getGraphifyInstallCommand(isUpdate: boolean): Promise<string> {
  await whenShellRuntimeReady();
  const inWsl = isWslRuntime();
  const has = (name: string) => (inWsl ? findInWsl(name) : findExecutableAsync(name));
  if (await has('uv')) {
    return isUpdate ? `uv tool upgrade ${GRAPHIFY_PACKAGE}` : `uv tool install ${GRAPHIFY_PACKAGE}`;
  }
  if (await has('pipx')) {
    return isUpdate ? `pipx upgrade ${GRAPHIFY_PACKAGE}` : `pipx install ${GRAPHIFY_PACKAGE}`;
  }
  const python = isWindows() && !inWsl ? 'py' : 'python3';
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
    links?: Array<{ source: string; target: string; relation?: string; confidence?: string }>;
    edges?: Array<{ source: string; target: string; relation?: string; confidence?: string }>;
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
    .map((link) => ({ source: String(link.source), target: String(link.target), relation: link.relation, confidence: link.confidence }))
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

async function build(projectPath: string, signal: AbortSignal): Promise<GraphifyIndexInfo> {
  const installation = await detectGraphify();
  if (!installation) throw new Error('Graphify is not installed');
  if (!(await isGraphifyEnabled(projectPath))) throw new Error('Use Graphify is off for this project');

  const memoryDir = getGraphifyMemoryDir(projectPath);
  // graphify takes GRAPHIFY_OUT over --out (and over cluster-only's directory), so an inherited
  // one would write every project's graph into whichever project that variable names. Workbench
  // sets it for the terminals and sessions it starts, so an app started from one of those has it.
  const outEnv = { GRAPHIFY_OUT: getGraphifyOutDir(projectPath) };

  // Code-only extraction parses the code locally (tree-sitter), so no API key is needed.
  // The graph mirrors the current code, so a rebuild may shrink it (graphify refuses that by default)
  const { stdout, stderr } = await runGraphify(
    installation.path,
    ['extract', projectPath, '--code-only', '--allow-dedup-shrink', '--out', memoryDir],
    projectPath,
    BUILD_TIMEOUT_MS,
    outEnv,
    signal
  );
  const output = `${stdout}\n${stderr}`;
  const stats = output.match(/(\d+) nodes, (\d+) edges(?:, (\d+) communities)?/);

  // A readable summary for agents (GRAPH_REPORT.md), without naming communities through an LLM
  try {
    await runGraphify(installation.path, ['cluster-only', memoryDir, '--no-label', '--no-viz'], projectPath, BUILD_TIMEOUT_MS, outEnv, signal);
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

const refreshesQueued = new Set<string>();

/**
 * Rebuild the project's memory graph after a task completed, so the next sessions see its changes.
 * A build already running may have started before the task's changes landed, so one more build
 * runs after it (several tasks completing meanwhile share that one). Null when Graphify isn't
 * installed or the refresh was folded into one already queued.
 */
export async function refreshGraphifyIndex(projectPath: string): Promise<GraphifyIndexInfo | null> {
  if (!(await detectGraphify())) return null;
  const running = buildsInProgress.get(projectPath);
  if (running) {
    if (refreshesQueued.has(projectPath)) return null;
    refreshesQueued.add(projectPath);
    await running.catch(() => undefined);
    refreshesQueued.delete(projectPath);
  }
  // Use Graphify may have been switched off meanwhile
  if (!(await isGraphifyEnabled(projectPath))) return null;
  return buildGraphifyIndex(projectPath);
}

/** Build (or rebuild) the project's memory graph; a build already running for it is reused */
export function buildGraphifyIndex(projectPath: string): Promise<GraphifyIndexInfo> {
  const running = buildsInProgress.get(projectPath);
  if (running) return running;
  const abort = new AbortController();
  const promise = build(projectPath, abort.signal).finally(() => {
    buildsInProgress.delete(projectPath);
    buildAborts.delete(projectPath);
  });
  buildsInProgress.set(projectPath, promise);
  buildAborts.set(projectPath, abort);
  return promise;
}

/**
 * Switch the project's Use Graphify on (creates .workbench/knowledge) or off (stops a running build
 * and removes .workbench/knowledge with its graph)
 */
export async function setGraphifyEnabled(projectPath: string, enabled: boolean): Promise<void> {
  const memoryDir = getGraphifyMemoryDir(projectPath);
  if (enabled) {
    await fs.mkdir(memoryDir, { recursive: true });
    return;
  }
  buildAborts.get(projectPath)?.abort();
  await buildsInProgress.get(projectPath)?.catch(() => undefined);
  await fs.rm(memoryDir, { recursive: true, force: true });
}

/** What an agent session needs to search the project's memory graph */
export interface GraphifyAgentContext {
  /** System prompt section introducing the CodebaseGraph tool */
  prompt: string;
  /**
   * The same section for Claude Code runs, which search the graph with graphify commands through
   * Bash instead (GRAPHIFY_OUT set to the graph's directory, so no --graph is needed)
   */
  commandPrompt: string;
  /** The graphify command */
  cli: string;
  /** The project's graph.json */
  graph: string;
}

/**
 * The project's memory graph for agents (the CodebaseGraph tool and a prompt section about it), or
 * null when Graphify isn't installed or the project has no graph yet. When Claude Code runs in
 * WSL, its graphify commands need graphify inside the distribution, and the paths in the command
 * prompt are the distribution's.
 */
export async function getGraphifyPromptContext(projectPath: string): Promise<GraphifyAgentContext | null> {
  // In WSL the detection finds the distribution's graphify
  const [installation, index] = await Promise.all([
    detectGraphify(),
    readGraphifyIndex(projectPath),
  ]);
  const cli = installation?.path;
  if (!cli || !index) return null;
  const graph = getGraphifyGraphPath(projectPath);
  const report = path.join(path.dirname(graph), 'GRAPH_REPORT.md');
  const intro = `A knowledge graph of this project's code (${index.nodes} nodes, ${index.edges} edges) is available`;
  const outroFor = (reportPath: string) => [
    '',
    `For an overview of the main modules, read \`${reportPath}\`. The graph was built ${formatDateTime(index.builtAt)}; code changed`,
    'since then is not in it, so confirm details in the files it points to.',
  ];
  const outro = outroFor(report);
  const prompt = [
    '## PROJECT CODE GRAPH (GRAPHIFY)',
    '',
    `${intro} through the \`CodebaseGraph\` tool. Search it before grepping or reading files to find where things`,
    'are and how they connect:',
    '',
    '- `query` with a question ("how are task logs written?"): the relevant symbols, their files and connections',
    '- `explain` a symbol: what it is and what it links to',
    '- `path` between two symbols: how they connect',
    '- `affected` by a symbol: what a change to it can impact',
    '- `hubs`: the most connected symbols, the core of the architecture',
    ...outro,
  ].join('\n');
  const commandPrompt = [
    '## PROJECT CODE GRAPH (GRAPHIFY)',
    '',
    `${intro}. Search it with these Bash commands before grepping or reading files to find where things are and`,
    'how they connect (only these graphify commands are allowed):',
    '',
    '- `graphify query "how are task logs written?"`: the relevant symbols, their files and connections',
    '- `graphify explain "SymbolName"`: what a symbol is and what it links to',
    '- `graphify path "SymbolA" "SymbolB"`: how two symbols connect',
    '- `graphify affected "SymbolName"`: what a change to a symbol can impact',
    '- `graphify god-nodes`: the most connected symbols, the core of the architecture',
    ...outroFor(toRuntimePath(report)),
  ].join('\n');
  return { prompt, commandPrompt, cli, graph };
}
