/**
 * The environment Claude Code runs with for an account:
 * - an account the app added runs on its own config dir, never on a shell API key
 * - a detected Claude Code setup on the default ~/.claude runs without CLAUDE_CONFIG_DIR (even
 *   when the app was started with one) and keeps the variables it may be configured with
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'os';
import path from 'path';

const profileEnvRef = vi.hoisted(() => ({ env: {} as Record<string, string>, detected: false }));

vi.mock('../../cli-utils', () => ({
  getClaudeCliInvocationAsync: async () => ({
    command: 'claude',
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-shell', CLAUDE_CONFIG_DIR: '/app/started/with' },
  }),
}));
vi.mock('../../cli-tool-manager', () => ({ getToolInfo: () => ({ found: false }) }));
vi.mock('../../services/profile', () => ({ getAPIProfileEnv: async () => ({}) }));
vi.mock('../../rate-limit-detector', () => ({
  getUsableProfileEnv: () => profileEnvRef.env,
  getBestAvailableProfileEnv: () => ({ env: profileEnvRef.env, profileId: 'p', profileName: 'P' }),
  isDetectedClaudeCodeProfile: () => profileEnvRef.detected,
}));

import { resolveClaudeEnv } from '../env';

beforeEach(() => {
  profileEnvRef.env = {};
  profileEnvRef.detected = false;
});

describe('resolveClaudeEnv', () => {
  it("runs an added account on its config dir, without the shell's API key", async () => {
    profileEnvRef.env = { CLAUDE_CONFIG_DIR: '/profiles/work', CLAUDE_CODE_OAUTH_TOKEN: 'cached' };
    const { env } = await resolveClaudeEnv({ profileId: 'work' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/profiles/work');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("runs Claude Code's default dir without CLAUDE_CONFIG_DIR, keeping the setup's variables", async () => {
    profileEnvRef.env = { CLAUDE_CONFIG_DIR: path.join(homedir(), '.claude') };
    profileEnvRef.detected = true;
    const { env } = await resolveClaudeEnv({ profileId: 'claude-code' });
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-shell');
  });
});
