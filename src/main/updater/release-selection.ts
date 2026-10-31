/**
 * Which published release Settings > Updates offers.
 *
 * electron-updater's GitHub provider doesn't pick by version number: with pre-releases allowed it
 * takes the most recently published entry of the releases feed, and without them GitHub's
 * "latest" release (the newest by date). So the app reads the release list itself and offers the
 * highest version among the eligible releases: stable ones always, pre-releases only with
 * Beta updates on.
 */

import semver from 'semver';

/** A published GitHub release, as far as updating is concerned */
export interface PublishedRelease {
  /** Semver version (the tag without its leading "v") */
  version: string;
  /** The git tag, as it appears in the release's download URLs */
  tag: string;
  prerelease: boolean;
  /** Release notes (GitHub markdown) */
  notes?: string;
  /** ISO date the release was published */
  publishedAt?: string;
}

/** What the running app should be offered */
export interface UpdateOffer {
  /** Highest eligible release (null when nothing eligible is published) */
  latest: PublishedRelease | null;
  /** A newer version to download */
  update: PublishedRelease | null;
  /**
   * The latest stable release when a pre-release is running with Beta updates off and that
   * pre-release is newer than every stable release (downloading it is a downgrade)
   */
  downgrade: PublishedRelease | null;
}

/** Turn the GitHub API's release list into published releases (drafts and non-semver tags left out) */
export function parseGitHubReleases(data: unknown): PublishedRelease[] {
  if (!Array.isArray(data)) return [];
  const releases: PublishedRelease[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const release = entry as {
      tag_name?: unknown;
      prerelease?: unknown;
      draft?: unknown;
      body?: unknown;
      published_at?: unknown;
    };
    if (release.draft === true || typeof release.tag_name !== 'string') continue;
    const version = semver.valid(semver.clean(release.tag_name, { loose: true }));
    if (!version) continue;
    releases.push({
      version,
      tag: release.tag_name,
      // A version with a pre-release suffix is a beta even if the release wasn't marked as one
      prerelease: release.prerelease === true || semver.prerelease(version) !== null,
      notes: typeof release.body === 'string' && release.body.trim() ? release.body : undefined,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined
    });
  }
  return releases;
}

/** The highest version among the eligible releases (pre-releases only when `betaUpdates` is on) */
export function pickHighestRelease(releases: PublishedRelease[], betaUpdates: boolean): PublishedRelease | null {
  let best: PublishedRelease | null = null;
  for (const release of releases) {
    if (release.prerelease && !betaUpdates) continue;
    if (!best || semver.gt(release.version, best.version)) best = release;
  }
  return best;
}

/** Whether a version has a pre-release suffix (e.g. 1.4.0-beta, 1.4.0-beta.2) */
export function isPrereleaseVersion(version: string): boolean {
  const parsed = semver.parse(version, { loose: true });
  return parsed !== null && parsed.prerelease.length > 0;
}

/**
 * Given the running version, the Beta updates setting and the published releases: the newer
 * version to offer, or the stable to go back to from a beta that is newer than every stable.
 */
export function chooseUpdateOffer(
  currentVersion: string,
  betaUpdates: boolean,
  releases: PublishedRelease[]
): UpdateOffer {
  const latest = pickHighestRelease(releases, betaUpdates);
  const current = semver.valid(semver.clean(currentVersion, { loose: true }));
  if (!latest || !current) return { latest, update: null, downgrade: null };

  if (semver.gt(latest.version, current)) return { latest, update: latest, downgrade: null };

  const downgrade =
    !betaUpdates && isPrereleaseVersion(current) && semver.lt(latest.version, current) ? latest : null;
  return { latest, update: null, downgrade };
}
