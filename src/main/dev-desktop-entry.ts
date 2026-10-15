/**
 * Linux desktop entry for development builds.
 *
 * GNOME (and other shells) take a window's taskbar/dock icon from the .desktop file whose
 * StartupWMClass matches the window class, falling back to a generic gear when none does. The
 * installed app ships an entry for "Workbench"; `npm run dev` runs as "Workbench Dev", so it
 * installs its own hidden entry with the app icon.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { appLog } from './app-logger';

const ENTRY_FILE = 'workbench-dev.desktop';

/** Write (or update) ~/.local/share/applications/workbench-dev.desktop for the dev window class */
export async function ensureDevDesktopEntry(wmClass: string, iconPath: string, projectDir: string): Promise<void> {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const file = path.join(dataHome, 'applications', ENTRY_FILE);
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${wmClass}`,
    'Comment=Workbench development build (npm run dev)',
    `Exec=sh -c "cd '${projectDir}' && npm run dev"`,
    `Icon=${iconPath}`,
    `StartupWMClass=${wmClass}`,
    // Only used to match the dev window to its icon, so keep it out of the app menu
    'NoDisplay=true',
    '',
  ].join('\n');

  try {
    const existing = await fs.readFile(file, 'utf-8').catch(() => null);
    if (existing === content) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  } catch (error) {
    appLog.warn('[main] Could not write the development desktop entry:', error);
  }
}
