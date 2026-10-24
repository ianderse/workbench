import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { resolve } from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({
      // Bundle these packages into the main process (they won't be in node_modules in packaged app)
      exclude: [
        'chokidar',
        'electron-log',
        'proper-lockfile',
        'semver',
        '@anthropic-ai/sdk',
        'electron-updater',
        '@electron-toolkit/utils',
        // debug -> ms (used by bundled dependencies)
        'debug',
        'ms',
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
    // Inlined instead of a postcss.config file: Tailwind is only needed by the renderer
    css: {
      postcss: {
        plugins: [tailwindcss()]
      }
    },
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
          // The project's own .workbench (task worktrees, data); not a match on any path, which
          // would ignore every file when the app itself runs from a task worktree
          resolve(__dirname, '.workbench/**'),
          '**/out/**',
          // Ignore the parent autonomous-coding directory's worktrees
          resolve(__dirname, '../.worktrees/**'),
          resolve(__dirname, '../.workbench/**'),
        ]
      }
    }
  }
});
