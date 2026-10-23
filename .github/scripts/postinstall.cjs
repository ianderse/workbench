#!/usr/bin/env node
/**
 * Post-install script for Workbench
 *
 *   1. On Linux, make Electron's chrome-sandbox root-owned and setuid
 *   2. Run electron-rebuild when node-pty isn't already built (it ships prebuilt binaries
 *      per platform, so this is only a fallback)
 */

const { spawn, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const isWindows = os.platform() === 'win32';
const isLinux = os.platform() === 'linux';

/**
 * Linux only: Electron's chrome-sandbox has to be owned by root with the setuid bit set, or
 * `npm run dev` fails with "The SUID sandbox helper binary was found, but is not configured
 * correctly". Installing packages resets the file, so fix it after every install.
 */
function fixChromeSandbox() {
  const sandbox = path.join(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'chrome-sandbox');

  let stats;
  try {
    stats = fs.statSync(sandbox);
  } catch {
    return; // Electron isn't installed here
  }

  // Already root-owned and setuid
  if (stats.uid === 0 && (stats.mode & 0o4000) !== 0) {
    return;
  }

  // Root (containers, CI images) can set it directly. Everyone else goes through sudo: a terminal
  // install can answer a password prompt, while CI and other non-interactive installs get -n so
  // npm never hangs waiting for one
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const canPrompt = Boolean(process.stdin.isTTY) && !process.env.CI;

  if (!asRoot && canPrompt) {
    console.log('[postinstall] chrome-sandbox needs root ownership and the setuid bit - sudo may ask for your password.');
  }

  const run = (cmd, args) => {
    if (asRoot) {
      return spawnSync(cmd, args, { stdio: 'ignore' });
    }
    return spawnSync('sudo', canPrompt ? [cmd, ...args] : ['-n', cmd, ...args], {
      stdio: canPrompt ? 'inherit' : 'ignore',
    });
  };

  const owned = run('chown', ['root:root', sandbox]);
  const result = owned.status === 0 ? run('chmod', ['4755', sandbox]) : owned;

  if (result.status === 0) {
    console.log('[postinstall] chrome-sandbox is root-owned and setuid.\n');
    return;
  }

  console.warn('[postinstall] Could not set chrome-sandbox permissions. Run this once:');
  console.warn(`  sudo chown root:root ${sandbox}`);
  console.warn(`  sudo chmod 4755 ${sandbox}\n`);
}

/**
 * Get electron version from package.json
 */
function getElectronVersion() {
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const electronVersion = pkg.devDependencies?.electron || pkg.dependencies?.electron;
  if (!electronVersion) {
    return null;
  }
  // Strip leading ^ or ~ from version
  return electronVersion.replace(/^[\^~]/, '');
}

/**
 * Run electron-rebuild
 */
function runElectronRebuild() {
  return new Promise((resolve, reject) => {
    const npx = isWindows ? 'npx.cmd' : 'npx';
    const electronVersion = getElectronVersion();
    const args = ['electron-rebuild'];

    // Explicitly pass electron version if detected
    if (electronVersion) {
      args.push('-v', electronVersion);
      console.log(`[postinstall] Using Electron version: ${electronVersion}`);
    }

    const child = spawn(npx, args, {
      stdio: 'inherit',
      shell: isWindows,
      cwd: path.join(__dirname, '..', '..'),
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        reject(new Error(`electron-rebuild exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

/**
 * Check if node-pty is already built
 */
function isNodePtyBuilt() {
  // Check traditional node-pty build location
  const localBuildDir = path.join(__dirname, '..', '..', 'node_modules', 'node-pty', 'build', 'Release');
  if (fs.existsSync(localBuildDir)) {
    const files = fs.readdirSync(localBuildDir);
    if (files.some((f) => f.endsWith('.node'))) return true;
  }

  // Check for @lydell/node-pty with platform-specific prebuilts
  const arch = os.arch();
  const platform = os.platform();
  const platformPkg = `@lydell/node-pty-${platform}-${arch}`;

  const localLydellDir = path.join(__dirname, '..', '..', 'node_modules', platformPkg);
  if (fs.existsSync(localLydellDir)) {
    const files = fs.readdirSync(localLydellDir);
    if (files.some((f) => f.endsWith('.node'))) return true;
  }

  return false;
}

/**
 * Not on Windows: install node-pty's Windows binary into node_modules/.cache/node-pty-win32, which
 * `npm run package:win` ships with the app (the `win.extraResources` entry in package.json). npm
 * only installs the binary of the machine it runs on, so a Windows package built on Linux or in
 * WSL otherwise has no Windows terminal binary. Release builds package Windows on Windows, so CI
 * skips this.
 */
function installWindowsPtyBinary() {
  if (isWindows || process.env.CI) return;

  const root = path.join(__dirname, '..', '..');
  let version;
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@lydell', 'node-pty', 'package.json'), 'utf8')).version;
  } catch {
    return; // node-pty isn't installed
  }

  const prefix = path.join(root, 'node_modules', '.cache', 'node-pty-win32');
  const installed = path.join(prefix, 'node_modules', '@lydell', 'node-pty', 'package.json');
  try {
    if (JSON.parse(fs.readFileSync(installed, 'utf8')).version === version) return;
  } catch {
    // Not installed yet
  }

  console.log(`[postinstall] Installing node-pty ${version}'s Windows binary for Windows packages...`);
  const result = spawnSync(
    'npm',
    ['install', '--prefix', prefix, '--os=win32', '--cpu=x64', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', `@lydell/node-pty@${version}`],
    { cwd: root, stdio: 'inherit' }
  );
  if (result.status !== 0) {
    console.warn('[postinstall] Could not install the Windows terminal binary; Windows packages built here will have no terminals.\n');
  }
}

/**
 * Main postinstall logic
 */
async function main() {
  console.log('[postinstall] Setting up native modules for Electron...\n');

  if (isLinux) {
    fixChromeSandbox();
  }

  installWindowsPtyBinary();

  // If node-pty is already built (e.g., from a previous successful install), skip
  if (isNodePtyBuilt()) {
    console.log('[postinstall] Native modules already built, skipping rebuild.');
    return;
  }

  // Run electron-rebuild
  try {
    console.log('[postinstall] Running electron-rebuild...\n');
    await runElectronRebuild();
    console.log('\n[postinstall] Native modules built successfully!');
  } catch (error) {
    console.error('\n[postinstall] Failed to build native modules.\n');
    console.error('Error:', error.message);
    console.error('\nYou may need to install build tools for your platform:');
    console.error('  Windows: Visual Studio Build Tools 2022 (Desktop development with C++)');
    console.error('  macOS: xcode-select --install');
    console.error('  Linux: sudo apt-get install build-essential\n');

    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[postinstall] Unexpected error:', err);
  process.exit(1);
});
