import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { createCipheriv, randomBytes } from 'crypto';
import { config as dotenvConfig } from 'dotenv';

// Load .env file for build-time constants (embedded API keys)
dotenvConfig({ path: resolve(__dirname, '.env') });

/**
 * Build-time constants embedded via Vite `define`.
 *
 * In CI builds, these come from GitHub secrets.
 * In local development, these come from .env (loaded by dotenv).
 *
 * The `define` option replaces these values at build time, so they're
 * embedded in the bundle and available at runtime in packaged apps.
 */
/** Embedded API keys — search works out of the box, no user config needed. */
const embeddedKeys = {
  '__SERPER_API_KEY__': JSON.stringify(process.env.SERPER_API_KEY || ''),
  '__UPDATER_GH_TOKEN__': JSON.stringify(encryptToken(process.env.UPDATER_GH_TOKEN)),
};

/**
 * GitHub token for update checks against the private release repository, encrypted with a
 * per-build key so the plain value is not in the bundle (see src/main/updater/github-token.ts)
 */
function encryptToken(token: string | undefined) {
  if (!token) return null;
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    data: data.toString('base64'),
    key: key.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export default defineConfig({
  main: {
    define: embeddedKeys,
    plugins: [externalizeDepsPlugin({
      // Bundle these packages into the main process (they won't be in node_modules in packaged app)
      exclude: [
        'uuid',
        'chokidar',
        'dotenv',
        'electron-log',
        'proper-lockfile',
        'semver',
        'zod',
        '@anthropic-ai/sdk',
        'electron-updater',
        '@electron-toolkit/utils',
        // debug -> ms (used by bundled dependencies)
        'debug',
        'ms',
        // Minimatch for glob pattern matching in worktree handlers
        'minimatch',
        // XState for task state machine
        'xstate',
      ]
    })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
        // Native modules that must remain external (loaded from disk, not bundled)
        external: ['@lydell/node-pty']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@features': resolve(__dirname, 'src/renderer/features'),
        '@components': resolve(__dirname, 'src/renderer/shared/components'),
        '@hooks': resolve(__dirname, 'src/renderer/shared/hooks'),
        '@lib': resolve(__dirname, 'src/renderer/shared/lib')
      }
    },
    server: {
      watch: {
        // Ignore directories to prevent HMR conflicts during merge operations
        // Using absolute paths and broader patterns
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.worktrees/**',
          '**/.auto-claude/**',
          '**/out/**',
          // Ignore the parent autonomous-coding directory's worktrees
          resolve(__dirname, '../.worktrees/**'),
          resolve(__dirname, '../.auto-claude/**'),
        ]
      }
    }
  }
});
