/**
 * Graphify (https://github.com/Graphify-Labs/graphify) builds a knowledge graph of a project's code.
 *
 * Auto Claude detects the `graphify` CLI (Settings > Updates), builds each project's memory graph
 * into .auto-claude/memory (Settings > Project > Memory index), and points agents at it when the
 * project's "Use Graphify" setting is on. Everything runs asynchronously so the main process never
 * blocks on the CLI.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { promises as fs } from 'fs';
import semver from 'semver';
import { findExecutableAsync, getAugmentedEnvAsync } from './env-utils';
import { isWindows, requiresShell } from './platform';
import { appLog } from './app-logger';
import type { GraphifyIndexInfo, GraphifyVersionInfo } from '../shared/types/cli';

const execFileAsync = promisify(execFile);

/** PyPI package that provides the `graphify` command */
const GRAPHIFY_PACKAGE = 'graphifyy';
const PYPI_URL = `https://pypi.org/pypi/${GRAPHIFY_PACKAGE}/json`;
const VERSION_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const INDEX_INFO_FILE = 'index.json';

interface GraphifyInstallation {
  path: string;
  version: string | null;
}

let detection: Promise<GraphifyInstallation | null> | null = null;
let latestVersion: Promise<string | null> | null = null;
const buildsInProgress = new Map<string, Promise<GraphifyIndexInfo>>();

/** Where a project's memory graph is stored */
export function getGraphifyMemoryDir(projectPath: string): string {
  return path.join(projectPath, '.auto-claude', 'memory');
}

/** The graph file Graphify writes for a project */
export function getGraphifyGraphPath(projectPath: string): string {
  return path.join(getGraphifyMemoryDir(projectPath), 'graphify-out', 'graph.json');
}

async function runGraphify(executable: string, args: string[], cwd?: string, timeout = VERSION_TIMEOUT_MS) {
  return execFileAsync(executable, args, {
    cwd,
    env: await getAugmentedEnvAsync(),
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
  return { installed, latest, isOutdated };
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
