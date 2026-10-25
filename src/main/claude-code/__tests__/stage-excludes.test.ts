import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReviewExcludes, buildStageExcludes, GENERATED_DIRS } from '../stage-excludes';

describe('stage excludes', () => {
  it('builds a glob exclude for every generated folder plus extra paths', () => {
    const excludes = buildStageExcludes(['.workbench']);
    expect(excludes[0]).toBe(':(exclude).workbench');
    for (const dir of GENERATED_DIRS) expect(excludes).toContain(`:(exclude,glob)**/${dir}/**`);
  });

  it('review excludes add lockfiles', () => {
    expect(buildReviewExcludes()).toContain(':(exclude,glob)**/package-lock.json');
  });

  describe('against a real repository', () => {
    let dir = '';
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('skips untracked generated folders (nested too) but still stages tracked changes inside them', () => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'stage-excludes-'));
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
      const write = (file: string, content: string) => {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), content);
      };
      run('init', '-q');
      run('config', 'user.email', 'a@b.c');
      run('config', 'user.name', 'a');
      write('src/a.ts', '1\n');
      write('dist/tracked.js', '1\n');
      run('add', '-A');
      run('commit', '-qm', 'init');

      appendFileSync(path.join(dir, 'src/a.ts'), '2\n');
      appendFileSync(path.join(dir, 'dist/tracked.js'), '2\n');
      write('node_modules/y/i.js', 'n');
      write('pkg/node_modules/x/i.js', 'n');
      write('.venv/lib/q', 'v');
      write('.workbench/f', 'w');
      write('new.ts', 'b');
      // Build output at the root is skipped; the same names deeper are real source and kept
      write('build/bundle.js', 'o');
      write('target/x.class', 'o');
      write('src/build/plan.ts', 's');
      write('packages/app/out/index.ts', 's');

      run('add', '-u', '--', '.', ':(exclude).workbench');
      run('add', '--', '.', ...buildStageExcludes(['.workbench']));
      const staged = run('diff', '--cached', '--name-only').trim().split('\n').sort();
      expect(staged).toEqual(['dist/tracked.js', 'new.ts', 'packages/app/out/index.ts', 'src/a.ts', 'src/build/plan.ts']);
    });
  });
});
