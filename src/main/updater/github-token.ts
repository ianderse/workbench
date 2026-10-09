/**
 * GitHub token for update checks against the private release repository.
 *
 * CI encrypts the UPDATER_GH_TOKEN secret with AES-256-GCM at build time (electron.vite.config.ts)
 * so the plain value never appears in the bundle. In dev, set UPDATER_GH_TOKEN in .env.
 */

import { createDecipheriv } from 'crypto';

interface EncryptedToken {
  data: string;
  key: string;
  iv: string;
  tag: string;
}

declare const __UPDATER_GH_TOKEN__: EncryptedToken | null;

let cached: string | null | undefined;

function decrypt({ data, key, iv, tag }: EncryptedToken): string {
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** The updater's GitHub token, or null when the build has none */
export function getUpdaterGitHubToken(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (typeof __UPDATER_GH_TOKEN__ !== 'undefined' && __UPDATER_GH_TOKEN__) {
    try {
      cached = decrypt(__UPDATER_GH_TOKEN__);
    } catch {
      cached = null;
    }
  } else if (process.env.UPDATER_GH_TOKEN) {
    cached = process.env.UPDATER_GH_TOKEN;
  }
  return cached;
}
