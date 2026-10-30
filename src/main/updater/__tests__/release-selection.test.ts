import { describe, it, expect } from 'vitest';
import {
  chooseUpdateOffer,
  parseGitHubReleases,
  pickHighestRelease,
  type PublishedRelease
} from '../release-selection';

function release(version: string, prerelease = version.includes('-')): PublishedRelease {
  return { version, tag: `v${version}`, prerelease };
}

describe('parseGitHubReleases', () => {
  it('reads tags, leaves out drafts and non-semver tags, and treats a pre-release suffix as a beta', () => {
    const releases = parseGitHubReleases([
      { tag_name: 'v1.4.0-beta', prerelease: true, draft: false, body: 'notes', published_at: '2026-10-01T00:00:00Z' },
      { tag_name: 'v1.3.0', prerelease: false, draft: false, body: '' },
      { tag_name: 'v1.5.0', prerelease: false, draft: true },
      { tag_name: 'nightly', prerelease: true, draft: false },
      { tag_name: 'v1.4.1-beta.2', prerelease: false, draft: false }
    ]);
    expect(releases).toEqual([
      { version: '1.4.0-beta', tag: 'v1.4.0-beta', prerelease: true, notes: 'notes', publishedAt: '2026-10-01T00:00:00Z' },
      { version: '1.3.0', tag: 'v1.3.0', prerelease: false, notes: undefined, publishedAt: undefined },
      { version: '1.4.1-beta.2', tag: 'v1.4.1-beta.2', prerelease: true, notes: undefined, publishedAt: undefined }
    ]);
  });

  it('returns nothing for a response that is not a list', () => {
    expect(parseGitHubReleases({ message: 'Not Found' })).toEqual([]);
  });
});

describe('pickHighestRelease', () => {
  it('takes the highest version number, not the first (most recently published) entry', () => {
    // Newest first, as GitHub lists them: a 1.2.1 hotfix published after 1.3.0
    const releases = [release('1.2.1'), release('1.3.0'), release('1.2.0')];
    expect(pickHighestRelease(releases, false)?.version).toBe('1.3.0');
  });

  it('leaves out pre-releases when Beta updates is off', () => {
    expect(pickHighestRelease([release('1.4.0-beta.1'), release('1.3.0')], false)?.version).toBe('1.3.0');
  });

  it('takes a newer beta when Beta updates is on', () => {
    expect(pickHighestRelease([release('1.3.0'), release('1.4.0-beta.1')], true)?.version).toBe('1.4.0-beta.1');
  });

  it('takes the stable when it is newer than every beta, even with Beta updates on', () => {
    // The beta was published last but its version is lower
    expect(pickHighestRelease([release('1.4.0-beta.3'), release('1.4.0'), release('1.3.0')], true)?.version).toBe('1.4.0');
    expect(pickHighestRelease([release('1.3.0-beta.1'), release('1.4.0')], true)?.version).toBe('1.4.0');
  });

  it('returns null when nothing eligible is published', () => {
    expect(pickHighestRelease([release('1.4.0-beta.1')], false)).toBeNull();
    expect(pickHighestRelease([], true)).toBeNull();
  });
});

describe('chooseUpdateOffer', () => {
  const releases = [release('1.4.0-beta.2'), release('1.3.0'), release('1.4.0-beta.1'), release('1.2.0')];

  it('offers the latest stable to a stable user with Beta updates off', () => {
    const offer = chooseUpdateOffer('1.2.0', false, releases);
    expect(offer.update?.version).toBe('1.3.0');
    expect(offer.downgrade).toBeNull();
  });

  it('offers the newest beta with Beta updates on', () => {
    expect(chooseUpdateOffer('1.2.0', true, releases).update?.version).toBe('1.4.0-beta.2');
    expect(chooseUpdateOffer('1.4.0-beta.1', true, releases).update?.version).toBe('1.4.0-beta.2');
  });

  it('offers nothing when the running version is the highest eligible one', () => {
    const offer = chooseUpdateOffer('1.3.0', false, releases);
    expect(offer).toEqual({ latest: releases[1], update: null, downgrade: null });
  });

  it('offers the stable as a downgrade to a beta user who turned Beta updates off', () => {
    const offer = chooseUpdateOffer('1.4.0-beta.2', false, releases);
    expect(offer.update).toBeNull();
    expect(offer.downgrade?.version).toBe('1.3.0');
  });

  it('offers a newer stable as an update (not a downgrade) to a beta user', () => {
    const offer = chooseUpdateOffer('1.3.0-beta.4', false, releases);
    expect(offer.update?.version).toBe('1.3.0');
    expect(offer.downgrade).toBeNull();
  });

  it('never offers a downgrade to a stable build newer than everything published', () => {
    expect(chooseUpdateOffer('2.0.0', false, releases)).toEqual({ latest: releases[1], update: null, downgrade: null });
    expect(chooseUpdateOffer('1.5.0-beta.1', true, releases).downgrade).toBeNull();
  });
});
