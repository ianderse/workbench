/**
 * Claude Code setups found in its own configuration (a fake home dir):
 * - the default ~/.claude signed in with a subscription (account in ~/.claude.json)
 * - a ~/.claude-* dir configured for a cloud provider in its settings.json
 * - managed settings win over a dir's settings, which win over the environment
 * - the app's own ~/.claude-profiles dirs and dirs without a setup are left out
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const homeRef = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => homeRef.dir, default: { ...actual, homedir: () => homeRef.dir } };
});

import { detectClaudeCodeSetups, detectedAccountName } from '../claude-code-detection';
import { getClaudeGlobalConfigPath, isDefaultClaudeConfigDir, withClaudeConfigDir } from '../config-dir-paths';

let root: string;
let managedFile: string;

const write = (file: string, data: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cc-detect-'));
  homeRef.dir = path.join(root, 'home');
  mkdirSync(homeRef.dir, { recursive: true });
  managedFile = path.join(root, 'managed-settings.json');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const detect = (env: NodeJS.ProcessEnv = {}, signedIn = new Set<string>()) =>
  detectClaudeCodeSetups({
    env,
    managedSettingsFile: managedFile,
    excludeUnder: [path.join(homeRef.dir, '.claude-profiles')],
    hasSubscriptionCredentials: (dir) => signedIn.has(dir),
  });

describe('config dir paths', () => {
  it("keeps the default dir's sign-in in ~/.claude.json and runs it without CLAUDE_CONFIG_DIR", () => {
    const defaultDir = path.join(homeRef.dir, '.claude');
    expect(isDefaultClaudeConfigDir('~/.claude')).toBe(true);
    expect(getClaudeGlobalConfigPath(defaultDir)).toBe(path.join(homeRef.dir, '.claude.json'));
    expect(getClaudeGlobalConfigPath('/x/work')).toBe(path.join('/x/work', '.claude.json'));
    expect(withClaudeConfigDir({ CLAUDE_CONFIG_DIR: defaultDir, A: '1' })).toEqual({ A: '1' });
    expect(withClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/x/work' })).toEqual({ CLAUDE_CONFIG_DIR: '/x/work' });
  });
});

describe('detectClaudeCodeSetups', () => {
  it('finds a subscription sign-in and a cloud provider setup, and masks secrets', () => {
    const defaultDir = path.join(homeRef.dir, '.claude');
    mkdirSync(defaultDir);
    write(path.join(homeRef.dir, '.claude.json'), {
      oauthAccount: { emailAddress: 'me@example.com', organizationName: 'Me', organizationType: 'claude_max' },
    });
    const workDir = path.join(homeRef.dir, '.claude-work');
    write(path.join(workDir, 'settings.json'), {
      env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', AWS_BEARER_TOKEN_BEDROCK: 'bedrock-secret-token-123456' },
      awsAuthRefresh: 'aws sso login',
    });
    // Not a setup: no provider, no sign-in
    write(path.join(homeRef.dir, '.claude-empty', 'settings.json'), { permissions: { allow: ['Bash'] } });
    // The app's own account dirs
    write(path.join(homeRef.dir, '.claude-profiles', 'primary', 'settings.json'), { env: { ANTHROPIC_API_KEY: 'k' } });

    const setups = detect({}, new Set([defaultDir]));
    expect(setups.map((setup) => [path.basename(setup.configDir), setup.provider])).toEqual([
      ['.claude', 'subscription'],
      ['.claude-work', 'bedrock'],
    ]);
    expect(setups[0]).toMatchObject({ isDefaultDir: true, email: 'me@example.com', organization: 'Me', plan: 'max' });
    expect(detectedAccountName(setups[0])).toBe('Claude Code');
    expect(detectedAccountName(setups[1])).toBe('Claude Code (work)');

    const values = Object.fromEntries(setups[1].values.map((value) => [value.key, value]));
    expect(values.AWS_REGION).toEqual({ key: 'AWS_REGION', value: 'us-east-1', source: path.join(workDir, 'settings.json') });
    expect(values.AWS_BEARER_TOKEN_BEDROCK.value).toBe('bedroc…3456');
    expect(values.awsAuthRefresh.value).toBe('aws sso login');
  });

  it("follows Claude Code's precedence: a provider switch, then a gateway token, an API key, a key helper", () => {
    const dir = path.join(homeRef.dir, '.claude-gw');
    write(path.join(dir, 'settings.json'), { env: { ANTHROPIC_AUTH_TOKEN: 'gateway-token-abcdefgh', ANTHROPIC_BASE_URL: 'https://llm.example.com' } });
    expect(detect().find((setup) => setup.configDir === dir)?.provider).toBe('auth-token');

    write(path.join(dir, 'settings.json'), { apiKeyHelper: '~/bin/get-key.sh' });
    expect(detect().find((setup) => setup.configDir === dir)?.provider).toBe('api-key-helper');

    // Managed settings win over the dir's own
    write(managedFile, { env: { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'acme' } });
    const managed = detect().find((setup) => setup.configDir === dir);
    expect(managed?.provider).toBe('vertex');
    expect(managed?.values.find((value) => value.key === 'ANTHROPIC_VERTEX_PROJECT_ID')?.source).toBe(managedFile);
  });

  it('counts the environment for the default dir only', () => {
    mkdirSync(path.join(homeRef.dir, '.claude'));
    mkdirSync(path.join(homeRef.dir, '.claude-other'));
    const setups = detect({ CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_RESOURCE: 'acme-ai', CLAUDE_CODE_USE_BEDROCK: '0' });
    expect(setups).toHaveLength(1);
    expect(setups[0]).toMatchObject({ isDefaultDir: true, provider: 'foundry' });
    expect(setups[0].values.find((value) => value.key === 'ANTHROPIC_FOUNDRY_RESOURCE')?.source).toBe('environment');
  });

  it('includes the dir CLAUDE_CONFIG_DIR names', () => {
    const custom = path.join(root, 'elsewhere', 'claude-config');
    write(path.join(custom, 'settings.json'), { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijkl' } });
    const setups = detect({ CLAUDE_CONFIG_DIR: custom });
    expect(setups.map((setup) => [setup.configDir, setup.provider])).toEqual([[custom, 'api-key']]);
  });
});
