/**
 * Automatic account switching never moves runs (or the active account) to an account without
 * credentials, and moves away from one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClaudeProfile } from '../../shared/types';

type Profile = Pick<ClaudeProfile, 'id' | 'name' | 'configDir'> & { signedIn: boolean; limited?: boolean };

const state = vi.hoisted(() => ({
  profiles: [] as Array<{ id: string; name: string; configDir?: string; signedIn: boolean; limited?: boolean }>,
  activeId: '',
  best: null as string | null,
}));

const manager = vi.hoisted(() => ({
  getActiveProfile: vi.fn(() => state.profiles.find(p => p.id === state.activeId)),
  getProfile: vi.fn((id: string) => state.profiles.find(p => p.id === id)),
  hasValidAuth: vi.fn((id: string) => !!state.profiles.find(p => p.id === id)?.signedIn),
  isProfileRateLimited: vi.fn((id: string) => ({ limited: !!state.profiles.find(p => p.id === id)?.limited })),
  getBestAvailableProfile: vi.fn(() => state.profiles.find(p => p.id === state.best) ?? null),
  setActiveProfile: vi.fn((id: string) => { state.activeId = id; return true; }),
  getProfileEnv: vi.fn((id: string) => ({ CLAUDE_CONFIG_DIR: `/profiles/${id}` })),
  getActiveProfileEnv: vi.fn(() => ({ CLAUDE_CONFIG_DIR: `/profiles/${state.activeId}` })),
}));

vi.mock('../claude-profile-manager', () => ({ getClaudeProfileManager: () => manager }));
vi.mock('../claude-profile/usage-monitor', () => ({
  getUsageMonitor: () => ({ getAllProfilesUsage: vi.fn(async () => null), emit: vi.fn() }),
}));

import { getBestAvailableProfileEnv, getUsableProfileEnv } from '../rate-limit-detector';

function setProfiles(profiles: Profile[], activeId: string, best: string | null): void {
  state.profiles = profiles;
  state.activeId = activeId;
  state.best = best;
}

describe('getBestAvailableProfileEnv', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stays on a rate-limited account rather than switching to one without credentials', () => {
    setProfiles([
      { id: 'primary', name: 'Primary', configDir: '/profiles/primary', signedIn: true, limited: true },
      { id: 'primary-1', name: 'Primary', configDir: '/profiles/primary-1', signedIn: false },
    ], 'primary', 'primary-1');

    const result = getBestAvailableProfileEnv();

    expect(result.profileId).toBe('primary');
    expect(result.wasSwapped).toBe(false);
    expect(manager.setActiveProfile).not.toHaveBeenCalled();
  });

  it('moves away from an active account without credentials to a signed-in one', () => {
    setProfiles([
      { id: 'primary', name: 'Primary', configDir: '/profiles/primary', signedIn: true },
      { id: 'primary-1', name: 'Primary', configDir: '/profiles/primary-1', signedIn: false },
    ], 'primary-1', 'primary');

    const result = getBestAvailableProfileEnv();

    expect(result).toMatchObject({ profileId: 'primary', wasSwapped: true, swapReason: 'not_authenticated' });
    expect(result.env.CLAUDE_CONFIG_DIR).toBe('/profiles/primary');
    expect(manager.setActiveProfile).toHaveBeenCalledWith('primary');
  });
});

describe('getUsableProfileEnv', () => {
  it('returns null for a removed profile or one without credentials', () => {
    setProfiles([
      { id: 'primary', name: 'Primary', configDir: '/profiles/primary', signedIn: true },
      { id: 'primary-1', name: 'Primary', configDir: '/profiles/primary-1', signedIn: false },
    ], 'primary', null);

    expect(getUsableProfileEnv('primary')).toEqual({ CLAUDE_CONFIG_DIR: '/profiles/primary' });
    expect(getUsableProfileEnv('primary-1')).toBeNull();
    expect(getUsableProfileEnv('gone')).toBeNull();
  });
});
