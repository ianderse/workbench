/**
 * Claude Code setups on this machine, found in Claude Code's own configuration (run on every app
 * start; see ClaudeProfileManager.syncDetectedAccounts).
 *
 * A setup is a config dir: Claude Code's default `~/.claude`, the dir CLAUDE_CONFIG_DIR names and
 * other `~/.claude-*` dirs (the "multiple accounts" pattern). Each one reaches Claude through a
 * provider chosen by Claude Code's authentication precedence: a cloud provider switch
 * (CLAUDE_CODE_USE_BEDROCK, ...), ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, apiKeyHelper,
 * CLAUDE_CODE_OAUTH_TOKEN, then the subscription sign-in from /login. Values come from the
 * managed settings file, the dir's settings.json and the environment, in that order.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { isMacOS, isWindows } from '../platform';
import type { ClaudeCodeProvider, DetectedClaudeCodeAccount, DetectedClaudeCodeValue } from '../../shared/types/agent';
import { getClaudeGlobalConfigPath, getDefaultClaudeConfigDir, isDefaultClaudeConfigDir } from './config-dir-paths';

/** Provider switches, in the order Claude Code checks them */
const PROVIDER_SWITCHES: Array<[string, ClaudeCodeProvider]> = [
  ['CLAUDE_CODE_USE_BEDROCK', 'bedrock'],
  ['CLAUDE_CODE_USE_MANTLE', 'mantle'],
  ['CLAUDE_CODE_USE_VERTEX', 'vertex'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'foundry'],
  ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'anthropic-aws'],
];

/** Variables that configure how Claude Code reaches Claude, in display order */
const SETUP_VARIABLES = [
  ...PROVIDER_SWITCHES.map(([name]) => name),
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_REGION',
  'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_BEDROCK_REGION_PREFIX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_BASE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const;

/** Settings keys about credentials and models */
const SETUP_SETTINGS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'model', 'forceLoginMethod'] as const;

const SECRET = /(KEY|TOKEN|SECRET|HEADERS)/;

export interface DetectedSetup extends DetectedClaudeCodeAccount {
  /** Absolute config dir */
  configDir: string;
}

export interface DetectionOptions {
  env?: NodeJS.ProcessEnv;
  managedSettingsFile?: string;
  /** Dirs the app manages itself (never reported) */
  excludeUnder?: string[];
  /** Whether a config dir holds a subscription sign-in's credentials (keychain or file) */
  hasSubscriptionCredentials: (configDir: string) => boolean;
}

interface Source {
  label: string;
  env: Record<string, string>;
  settings: Record<string, unknown>;
}

/** Claude Code's managed settings file for this OS */
export function getManagedSettingsFile(): string {
  if (isMacOS()) return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (isWindows()) return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function settingsSource(file: string): Source | null {
  const data = readJson(file);
  if (!data) return null;
  const env: Record<string, string> = {};
  if (data.env && typeof data.env === 'object') {
    for (const [key, value] of Object.entries(data.env as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') env[key] = String(value);
    }
  }
  return { label: file, env, settings: data };
}

function isOn(value: string | undefined): boolean {
  return !!value && !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function mask(key: string, value: string): string {
  if (!SECRET.test(key)) return value;
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : '••••';
}

/** The setup of one config dir, or null when it has nothing that reaches Claude */
export function readClaudeCodeSetup(configDir: string, options: DetectionOptions): DetectedSetup | null {
  const isDefaultDir = isDefaultClaudeConfigDir(configDir);
  const managed = settingsSource(options.managedSettingsFile ?? getManagedSettingsFile());
  const user = settingsSource(path.join(configDir, 'settings.json'));
  const envVars: Record<string, string> = {};
  for (const name of SETUP_VARIABLES) {
    const value = (options.env ?? process.env)[name];
    if (value) envVars[name] = value;
  }
  const environment: Source = { label: 'environment', env: envVars, settings: {} };
  // Precedence: managed settings, the dir's settings, then the environment
  const sources = [managed, user, environment].filter((source): source is Source => source !== null);

  const values: DetectedClaudeCodeValue[] = [];
  const effective = new Map<string, { value: string; source: Source }>();
  for (const name of SETUP_VARIABLES) {
    const source = sources.find((candidate) => candidate.env[name]);
    if (!source) continue;
    effective.set(name, { value: source.env[name], source });
    values.push({ key: name, value: mask(name, source.env[name]), source: source.label });
  }
  for (const key of SETUP_SETTINGS) {
    const source = sources.find((candidate) => typeof candidate.settings[key] === 'string' && candidate.settings[key]);
    if (!source) continue;
    const value = String(source.settings[key]);
    effective.set(key, { value, source });
    values.push({ key, value, source: source.label });
  }

  // The subscription sign-in (/login) of the dir
  const globalConfigPath = getClaudeGlobalConfigPath(configDir);
  const account = readJson(globalConfigPath)?.oauthAccount as Record<string, unknown> | undefined;
  const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const email = str(account?.emailAddress);
  const signedIn = !!email && options.hasSubscriptionCredentials(configDir);
  const plan = /^claude_([a-z]+)$/i.exec(str(account?.organizationType) ?? '')?.[1]?.toLowerCase();

  // Claude Code's authentication precedence
  const set = (name: string) => effective.get(name)?.value;
  let provider: ClaudeCodeProvider | null = PROVIDER_SWITCHES.find(([name]) => isOn(set(name)))?.[1] ?? null;
  if (!provider && set('ANTHROPIC_AUTH_TOKEN')) provider = 'auth-token';
  if (!provider && set('ANTHROPIC_API_KEY')) provider = 'api-key';
  if (!provider && set('apiKeyHelper')) provider = 'api-key-helper';
  if (!provider && set('CLAUDE_CODE_OAUTH_TOKEN')) provider = 'oauth-token';
  if (!provider && signedIn) provider = 'subscription';
  if (!provider) return null;

  // A dir other than the default one counts only for what it configures itself; values from the
  // managed settings and the environment apply to every dir
  if (!isDefaultDir) {
    const ownValues = [...effective.values()].some(({ source }) => source === user);
    if (!signedIn && !ownValues) return null;
  }

  return {
    configDir,
    provider,
    isDefaultDir,
    ...(provider === 'subscription' || signedIn ? { email, organization: str(account?.organizationName), plan } : {}),
    values,
  };
}

/** The config dirs Claude Code may use on this machine */
function candidateConfigDirs(options: DetectionOptions): string[] {
  const home = homedir();
  const dirs = new Set<string>([getDefaultClaudeConfigDir()]);
  const fromEnv = (options.env ?? process.env).CLAUDE_CONFIG_DIR;
  if (fromEnv) dirs.add(path.resolve(fromEnv.startsWith('~') ? path.join(home, fromEnv.slice(1)) : fromEnv));
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.claude[-_.].+/.test(entry.name)) dirs.add(path.join(home, entry.name));
    }
  } catch {
    // An unreadable home dir leaves the default and CLAUDE_CONFIG_DIR
  }
  const excluded = (options.excludeUnder ?? []).map((dir) => path.resolve(dir));
  return [...dirs].filter((dir) =>
    existsSync(dir) && !excluded.some((root) => dir === root || dir.startsWith(root + path.sep))
  );
}

/** Every Claude Code setup on this machine that reaches Claude */
export function detectClaudeCodeSetups(options: DetectionOptions): DetectedSetup[] {
  return candidateConfigDirs(options)
    .map((dir) => readClaudeCodeSetup(dir, options))
    .filter((setup): setup is DetectedSetup => setup !== null);
}

/** Name a detected setup gets until the user renames it */
export function detectedAccountName(setup: DetectedSetup): string {
  if (setup.isDefaultDir) return 'Claude Code';
  return `Claude Code (${path.basename(setup.configDir).replace(/^\.claude[-_.]?/, '') || path.basename(setup.configDir)})`;
}
