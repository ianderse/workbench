/**
 * Live agent setup for one project, from agent-flow's setup script (relay/setup.js):
 *   1. Installs the hook forwarding script at <project>/.auto-claude/flow/hook.cjs
 *   2. Configures Claude Code hooks in <project>/.claude/settings.local.json
 *
 * The project's .auto-claude/flow directory is also where the relay advertises itself (its
 * discovery files), and whether it exists is the project's "Live agent" setting.
 */
import * as fs from 'fs'
import * as path from 'path'
import { isWindows } from '../platform'
import { appLog } from '../app-logger'

/** A project's Live agent directory: the hook script and the relay's discovery files */
export function getFlowDir(projectPath: string): string {
  return path.join(projectPath, '.auto-claude', 'flow')
}

const hookScriptPath = (projectPath: string) => path.join(getFlowDir(projectPath), 'hook.cjs')
const settingsPath = (projectPath: string) => path.join(projectPath, '.claude', 'settings.local.json')

const HOOK_TIMEOUT_S = 2
const HOOK_SAFETY_MARGIN_MS = 500
const HOOK_FORWARD_TIMEOUT_MS = 1000
// Where the hook script lives, as it appears in our hook commands
const HOOK_COMMAND_MARKER = '/.auto-claude/flow/hook.cjs'

// ─── Hook script content ────────────────────────────────────────────────────

// .cjs: a project whose package.json says "type": "module" would load a .js as ESM
function getHookScriptContent() {
  return `#!/usr/bin/env node
// Agent Flow hook forwarder — installed by Auto Claude (Live agent).
// Claude Code invokes this as a command hook. It reads the discovery files next
// to it to find live relay instances, checks their PIDs, and forwards the event
// via HTTP POST. Dead instances are cleaned up automatically.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

setTimeout(() => process.exit(0), ${HOOK_TIMEOUT_S * 1000 - HOOK_SAFETY_MARGIN_MS});

const DIR = __dirname;
// Case-folded on Windows, where shells and Claude Code disagree on drive-letter
// case (\`c:\\...\` vs \`C:\\...\`)
function normPath(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch {}
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// Signal 0 only checks that the process exists (on Windows too); EPERM means
// it exists but isn't ours to signal
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  let cwd;
  try { cwd = JSON.parse(input).cwd; } catch { process.exit(0); }
  if (!cwd) process.exit(0);

  const resolvedCwd = normPath(cwd);

  let allFiles;
  try {
    allFiles = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  } catch { process.exit(0); }
  if (!allFiles.length) process.exit(0);

  const matches = [];
  for (const file of allFiles) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch { continue; }
    if (!d.workspace || !d.pid || !d.port) continue;

    if (!isAlive(d.pid)) {
      try { fs.unlinkSync(path.join(DIR, file)); } catch {}
      continue;
    }

    const ws = normPath(d.workspace);
    if (resolvedCwd === ws || resolvedCwd.startsWith(ws + path.sep)) {
      matches.push({ d, wsLen: ws.length });
    }
  }

  if (!matches.length) process.exit(0);

  matches.sort((a, b) => b.wsLen - a.wsLen);
  const bestLen = matches[0].wsLen;
  const targets = matches.filter(m => m.wsLen === bestLen);

  let pending = targets.length;
  for (const { d } of targets) {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; done(); };
    const req = http.request({
      hostname: '127.0.0.1', port: d.port, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: ${HOOK_FORWARD_TIMEOUT_MS},
    }, res => { res.resume(); res.on('end', finish); });
    req.on('error', finish);
    req.on('timeout', () => { req.destroy(); });
    req.write(input);
    req.end();
  }

  function done() { if (--pending <= 0) process.exit(0); }
});
`
}

// ─── Install hook script ────────────────────────────────────────────────────

function ensureHookScript(projectPath: string) {
  const scriptPath = hookScriptPath(projectPath)
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })

  const script = getHookScriptContent()
  try {
    if (fs.existsSync(scriptPath) && fs.readFileSync(scriptPath, 'utf8') === script) return
  } catch {}

  replaceFile(scriptPath, tmpPath => fs.writeFileSync(tmpPath, script, { mode: 0o755 }))
  appLog.info('[LiveAgent] Installed hook script:', scriptPath)
}

// ─── Configure Claude Code hooks ────────────────────────────────────────────

// The relay reads sessions from their transcripts; hooks add what those can't
// tell promptly (see relay/lib/hook-server.ts): tool calls and sub-agents as
// they start, permission prompts, and turns, sub-agents and sessions ending.
const HOOK_EVENTS = ['PreToolUse', 'Notification', 'Stop', 'SessionEnd', 'SubagentStop']
// Run in the background, so Claude Code doesn't wait for them. Stop runs in
// step, so the relay has it before the next turn can start (a late one would end
// that turn); SessionEnd too, as Claude Code exits, which could cut it short.
const ASYNC_HOOK_EVENTS = ['PreToolUse', 'Notification', 'SubagentStop']

interface CommandHook { type?: string; command?: string; url?: string; timeout?: number; async?: boolean }
interface HookEntry { matcher?: string; hooks?: CommandHook[] }
type Settings = Record<string, unknown> & { hooks?: Record<string, HookEntry[]> }

/** Our hook entry for an event. Auto Claude's own executable runs the hook as
 *  Node (Claude Code's PATH may have no node); hook commands run in a POSIX
 *  shell (Git Bash on Windows), so the variable prefix works everywhere. */
function ourHookEntry(projectPath: string, event: string): HookEntry {
  const slashes = (p: string) => (isWindows() ? p.replace(/\\/g, '/') : p)
  const command = `ELECTRON_RUN_AS_NODE=1 "${slashes(process.execPath)}" "${slashes(hookScriptPath(projectPath))}"`
  const hook: CommandHook = { type: 'command', command, timeout: HOOK_TIMEOUT_S }
  if (ASYNC_HOOK_EVENTS.includes(event)) hook.async = true
  return { hooks: [hook] }
}

/** Whether a hook (one command in a matcher group) is ours */
function isOurHook(hook: CommandHook | undefined) {
  return typeof hook?.command === 'string' && hook.command.replace(/\\/g, '/').includes(HOOK_COMMAND_MARKER)
}

/** Whether a matcher group holds one of our hooks */
function isAgentFlowHook(entry: HookEntry | undefined) {
  return Array.isArray(entry?.hooks) && entry.hooks.some(isOurHook)
}

/**
 * Read a settings file. Missing reads as {}. A file that exists but can't be
 * parsed returns { error } so we never overwrite the user's settings.
 */
function readSettings(file: string): { settings?: Settings; error?: string } {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {} }
    return { error: (err as Error).message }
  }
  if (raw.trim() === '') return { settings: {} }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'top-level value is not an object' }
    }
    return { settings: parsed }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/** Where a settings file really is: a symlink (e.g. into a dotfiles repo) is
 *  followed, even one whose target doesn't exist yet */
function resolveLink(filePath: string) {
  let target = filePath
  for (let hops = 0; hops < 40; hops++) {
    let link: string
    try { link = fs.readlinkSync(target) } catch { return target /* not a symlink, or missing */ }
    // Relative to the folder the link really is in (`..` follows that folder, not the path)
    let dir = path.dirname(target)
    try { dir = fs.realpathSync(dir) } catch { /* missing: taken as written */ }
    target = path.resolve(dir, link)
  }
  return target
}

/** Write JSON atomically where `filePath` points, keeping its permissions */
function writeJsonAtomic(filePath: string, value: unknown) {
  const target = resolveLink(filePath)
  let mode: number | undefined
  try { mode = fs.statSync(target).mode & 0o777 } catch { /* new file */ }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  replaceFile(target, tmpPath => {
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n')
    if (mode !== undefined) fs.chmodSync(tmpPath, mode) // exactly, regardless of the umask
  })
}

/** Replace a file atomically: `write` fills a temporary file beside it, which
 *  is then renamed over it (and removed if anything fails) */
function replaceFile(filePath: string, write: (tmpPath: string) => void) {
  const tmpPath = `${filePath}.${process.pid}.tmp`
  try {
    write(tmpPath)
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* never created */ }
    throw err
  }
}

/** Why a settings file can't be written, if it can't: it's read-only, or its
 *  folder is (writeJsonAtomic replaces it from a temporary file beside it) */
function unwritableReason(filePath: string) {
  const target = resolveLink(filePath)
  try { fs.accessSync(target, fs.constants.W_OK) } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'it is read-only'
  }
  try { fs.accessSync(path.dirname(target), fs.constants.W_OK) } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'its folder is read-only'
  }
  return undefined
}

/** Our hooks removed from every event, keeping other tools' hooks, even ones
 *  sharing a matcher group with ours */
function withoutOurHooks(existingHooks: Record<string, HookEntry[]>) {
  for (const [event, entries] of Object.entries(existingHooks)) {
    if (!entries.some(isAgentFlowHook)) continue // nothing of ours: left exactly as it is
    const kept = entries.flatMap(entry => {
      if (!isAgentFlowHook(entry)) return [entry]
      const hooks = entry.hooks!.filter(hook => !isOurHook(hook))
      return hooks.length > 0 ? [{ ...entry, hooks }] : []
    })
    if (kept.length > 0) existingHooks[event] = kept
    else delete existingHooks[event]
  }
  return existingHooks
}

/** Read the project's settings for a change to its hooks; returns why it can't be changed */
function readHookSettings(file: string): { settings?: Settings; error?: string } {
  const { settings, error } = readSettings(file)
  const hooks = settings?.hooks
  const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)
  const hooksError = error
    ?? (hooks !== undefined && !isObject(hooks) ? '"hooks" is not an object' : undefined)
    ?? (isObject(hooks) && Object.values(hooks!).some(entries => !Array.isArray(entries)) ? 'a "hooks" event is not a list' : undefined)
    ?? unwritableReason(file)
  return hooksError ? { error: hooksError } : { settings }
}

/** Returns an error message if the settings file was left alone */
function configureHooks(projectPath: string): string | undefined {
  const file = settingsPath(projectPath)
  const { settings, error } = readHookSettings(file)
  if (error || !settings) return `Can't update ${file} (${error}). It was left untouched.`

  // Then add ours back for the events we use (older installs registered more events)
  const existingHooks = withoutOurHooks(settings.hooks ?? {})
  for (const event of HOOK_EVENTS) {
    existingHooks[event] = [...(existingHooks[event] || []), ourHookEntry(projectPath, event)]
  }
  settings.hooks = existingHooks

  try {
    writeJsonAtomic(file, settings)
  } catch (err) {
    return `Can't update ${file} (${(err as Error).message}). It was left untouched.`
  }
  appLog.info('[LiveAgent] Configured Claude Code hooks in:', file)
  return undefined
}

// ─── Detection ──────────────────────────────────────────────────────────────

function isAlreadySetup(projectPath: string) {
  // The installed hook script must be the current one
  try {
    if (fs.readFileSync(hookScriptPath(projectPath), 'utf8') !== getHookScriptContent()) return false
  } catch { return false }

  // Set up exactly when our current hook entry (alone in its matcher group) is
  // registered for HOOK_EVENTS and nothing else, so running setup again
  // migrates older installs (or a moved Auto Claude executable)
  const { settings } = readSettings(settingsPath(projectPath))
  const hooks = settings?.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false
  const ours = Object.entries(hooks).flatMap(([event, entries]) =>
    Array.isArray(entries) ? entries.filter(entry => isAgentFlowHook(entry)).map(entry => [event, entry] as const) : [])
  return ours.length === HOOK_EVENTS.length
    && new Set(ours.map(([event]) => event)).size === HOOK_EVENTS.length
    && ours.every(([event, entry]) => HOOK_EVENTS.includes(event) && JSON.stringify(entry) === JSON.stringify(ourHookEntry(projectPath, event)))
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Set a project up for Live agent: its flow directory (which switches the
 * setting on), the hook script and the Claude Code hooks. Returns why the
 * hooks couldn't be configured, if they couldn't: the graph then works from
 * the transcripts alone.
 */
export function setUpProject(projectPath: string): { hooksError?: string } {
  fs.mkdirSync(getFlowDir(projectPath), { recursive: true })
  if (isAlreadySetup(projectPath)) return {}
  try {
    ensureHookScript(projectPath)
  } catch (err) {
    const hooksError = `Can't install the hook script at ${hookScriptPath(projectPath)} (${(err as Error).message}).`
    appLog.warn('[LiveAgent]', hooksError)
    return { hooksError }
  }
  const hooksError = configureHooks(projectPath)
  if (hooksError) appLog.warn('[LiveAgent]', hooksError)
  return hooksError ? { hooksError } : {}
}

/** Undo setUpProject: our hooks leave the project's settings, and its flow directory goes
 *  (which switches the setting off) */
export function removeFromProject(projectPath: string): void {
  const file = settingsPath(projectPath)
  const { settings, error } = readHookSettings(file)
  if (settings?.hooks && Object.values(settings.hooks).some(entries => entries.some(isAgentFlowHook))) {
    const hooks = withoutOurHooks(settings.hooks)
    if (Object.keys(hooks).length > 0) settings.hooks = hooks
    else delete settings.hooks
    try {
      writeJsonAtomic(file, settings)
    } catch (err) {
      appLog.warn(`[LiveAgent] Can't remove the hooks from ${file}:`, err)
    }
  } else if (error && fs.existsSync(file)) {
    appLog.warn(`[LiveAgent] Can't remove the hooks from ${file} (${error})`)
  }
  fs.rmSync(getFlowDir(projectPath), { recursive: true, force: true })
}
