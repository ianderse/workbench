/**
 * Home Assistant access token storage. The token never goes into settings.json: it is encrypted
 * with Electron safeStorage (OS keychain) and kept in its own file in the user data folder. When
 * secure storage is unavailable the token is not stored at all.
 */
import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';

const tokenPath = (): string => path.join(app.getPath('userData'), 'phone-notify-token.bin');

export function saveHaToken(token: string): { success: boolean; error?: string } {
  const value = token.trim();
  try {
    if (!value) {
      if (existsSync(tokenPath())) unlinkSync(tokenPath());
      return { success: true };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: 'Secure storage is not available on this system, so the token was not saved' };
    }
    writeFileSync(tokenPath(), safeStorage.encryptString(value), { mode: 0o600 });
    return { success: true };
  } catch {
    return { success: false, error: 'Could not save the token' };
  }
}

export function loadHaToken(): string {
  try {
    if (!existsSync(tokenPath()) || !safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(readFileSync(tokenPath()));
  } catch {
    return '';
  }
}

export function hasHaToken(): boolean {
  return existsSync(tokenPath());
}
