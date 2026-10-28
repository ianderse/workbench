/**
 * MCP server availability
 * =======================
 *
 * Whether each connector's server can start where Claude Code runs. A stdio server is started
 * once, as a run would start it, until it answers the MCP `initialize` request: the first start
 * of an npx server downloads it (Puppeteer also downloads Chromium), so it is "preparing" until
 * then. A missing command or a server that fails, exits or doesn't answer makes it
 * "unavailable". Servers that need more than their own process (Puppeteer needs a browser) are
 * also asked to use it once. HTTP servers are reachable or not.
 *
 * Results are kept for the app session (per connector and its connection details) and sent to
 * every window as they change. The Connectors page, the task dialog and the chat's MCP menu keep
 * a server's switch off and disabled until it is ready; runs leave out unavailable servers.
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { McpConnectorSettings } from '../shared/types/settings';
import type { McpAvailability } from '../shared/types/project';
import { mcpServerEntry, type McpServerEntry } from './claude-code/mcp-config';
import { findWslCommand, isCommandAvailable } from './mcp-commands';
import { getWslInfo, whenShellRuntimeReady } from './platform/shell-runtime';
import { killRuntimeProcess, spawnTool } from './platform/runtime-exec';

/** How long a server may take to answer: its first start downloads it */
const START_TIMEOUT_MS = 5 * 60 * 1000;
/** How long an HTTP server may take to answer */
const HTTP_TIMEOUT_MS = 10 * 1000;

/** A tool call that proves a server can do its work, not only start */
interface VerifyCall {
  name: string;
  arguments: Record<string, unknown>;
  /** The command that fixes a failed call, shown to the user (from the call's error) */
  fix?: (error: string) => string;
}

/**
 * Puppeteer's server starts without a browser and only needs one for its tools: it opens a blank
 * page in a hidden browser (closed when the server is stopped)
 */
const VERIFY_CALLS: Record<string, VerifyCall> = {
  puppeteer: {
    name: 'puppeteer_navigate',
    arguments: { url: 'about:blank', launchOptions: { headless: true } },
    // Puppeteer needs the exact Chrome build its error names ("Could not find Chrome (ver. X)")
    fix: (error) => {
      const version = /\(ver\. ([\d.]+)\)/.exec(error)?.[1];
      return `npx puppeteer browsers install chrome${version ? `@${version}` : ''}`;
    },
  },
};

const events = new EventEmitter();
/** Latest result per connector id and the entry it was found for */
const results = new Map<string, { key: string; availability: McpAvailability }>();
const probes = new Map<string, Promise<McpAvailability>>();

/** Called with each connector whose availability changed */
export function onMcpAvailabilityChange(listener: (id: string, availability: McpAvailability) => void): () => void {
  events.on('change', listener);
  return () => events.off('change', listener);
}

function set(id: string, key: string, availability: McpAvailability): McpAvailability {
  results.set(id, { key, availability });
  events.emit('change', id, availability);
  return availability;
}

/**
 * The connectors' availability now; servers not checked yet (or whose connection details
 * changed) start being checked and read "preparing"
 */
export function getMcpAvailability(ids: string[], settings: McpConnectorSettings | undefined): Record<string, McpAvailability> {
  return Object.fromEntries(ids.map((id) => [id, check(id, settings)]));
}

/** The connector ids a run can use: unavailable ones are left out (preparing ones stay in) */
export function usableMcpConnectorIds(ids: string[], settings: McpConnectorSettings | undefined): string[] {
  return ids.filter((id) => check(id, settings).state !== 'unavailable');
}

function check(id: string, settings: McpConnectorSettings | undefined): McpAvailability {
  const entry = mcpServerEntry(id, settings);
  if (!entry) return { state: 'ready' };
  const key = JSON.stringify(entry);
  const known = results.get(id);
  if (known?.key === key) return known.availability;
  if (!probes.has(key)) {
    set(id, key, { state: 'preparing' });
    const probe = probeEntry(entry, VERIFY_CALLS[id]).catch((error: unknown) => ({
      state: 'unavailable' as const,
      message: error instanceof Error ? error.message : String(error),
    }));
    probes.set(key, probe);
    void probe.then((availability) => {
      probes.delete(key);
      // Only when the connector still has these connection details
      if (results.get(id)?.key === key) set(id, key, availability);
    });
  }
  return { state: 'preparing' };
}

async function probeEntry(entry: McpServerEntry, verify?: VerifyCall): Promise<McpAvailability> {
  if (entry.type === 'http') return probeHttp(entry.url, entry.headers);

  await whenShellRuntimeReady();
  // In WSL the server runs inside the distribution, so its command is looked up and started there
  let command = entry.command;
  if (getWslInfo()) {
    const found = (await findWslCommand(entry.command)).path;
    if (!found) return { state: 'unavailable', missingCommand: entry.command };
    command = found;
  } else if (!(await isCommandAvailable(entry.command))) {
    return { state: 'unavailable', missingCommand: entry.command };
  }
  return startAndInitialize(command, entry.args ?? [], entry.env, verify);
}

async function probeHttp(url: string, headers: Record<string, string> | undefined): Promise<McpAvailability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: controller.signal });
    // Any answer below 500 means the server is there (MCP endpoints often refuse a plain GET)
    return response.status < 500
      ? { state: 'ready' }
      : { state: 'unavailable', message: `HTTP ${response.status}` };
  } catch (error) {
    return { state: 'unavailable', message: controller.signal.aborted ? 'No answer' : error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** The first sentence of an error (Puppeteer's go on with installation hints) */
function firstSentence(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? '';
  return firstLine.split(/\.\s+(?=[A-Z])/)[0].replace(/\.$/, '');
}

/**
 * Start a stdio server and wait for its answer to `initialize` (and to the verifying tool call,
 * when the server has one), then stop it
 */
function startAndInitialize(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  verify?: VerifyCall
): Promise<McpAvailability> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawnTool('python', args, {
        command,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
    } catch (error) {
      resolve({ state: 'unavailable', message: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (availability: McpAvailability) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killRuntimeProcess(proc);
      resolve(availability);
    };
    const timer = setTimeout(() => finish({ state: 'unavailable', message: 'Did not start in time' }), START_TIMEOUT_MS);

    const send = (message: Record<string, unknown>) => proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    let initialized = false;
    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8');
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        let message: { id?: unknown; result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue; // Not a JSON-RPC line (some servers log to stdout)
        }
        if (message.id === 1 && message.result && !initialized) {
          initialized = true;
          if (!verify) {
            finish({ state: 'ready' });
            return;
          }
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/call', params: { name: verify.name, arguments: verify.arguments } });
        } else if (message.id === 2) {
          const failure = message.error?.message
            ?? (message.result?.isError ? message.result.content?.map((part) => part.text ?? '').join(' ') : undefined);
          finish(failure === undefined
            ? { state: 'ready' }
            : { state: 'unavailable', message: firstSentence(failure) || 'Failed', ...(verify?.fix ? { fixCommand: verify.fix(failure) } : {}) });
          return;
        }
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString('utf-8')).slice(-2000);
    });
    proc.on('error', (error) => finish({ state: 'unavailable', message: error.message }));
    proc.on('close', (code) => {
      const lastLine = stderr.trim().split('\n').filter(Boolean).at(-1);
      finish({ state: 'unavailable', message: lastLine || `Exited with code ${code ?? 'unknown'}` });
    });

    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'workbench', version: '1.0.0' } },
    });
  });
}
