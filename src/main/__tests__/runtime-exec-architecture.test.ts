/**
 * Every launch of git and the other detected tools goes through the runtime layer
 * (platform/runtime-exec.ts, and utils/git-exec.ts for git), so where a tool runs is decided in
 * one place. This fails on new code that spawns a detected tool path or a literal `git` itself.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const MAIN_DIR = path.resolve(__dirname, '..');

/** Files allowed to launch tools directly */
const ALLOWED = new Set(['platform/runtime-exec.ts', 'utils/git-exec.ts']);

const FORBIDDEN: Array<{ pattern: RegExp; use: string }> = [
  {
    pattern: /\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync)\s*\(\s*getToolPath(?:Async)?\(/,
    use: 'runTool()/spawnTool() from platform/runtime-exec (git() from utils/git-exec for git)',
  },
  {
    pattern: /promisify\(\s*execFile\s*\)\(\s*getToolPath(?:Async)?\(/,
    use: 'runTool() from platform/runtime-exec',
  },
  {
    pattern: /\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync)\s*\(\s*['"`]git['"`]/,
    use: 'git() from utils/git-exec',
  },
  {
    pattern: /\b(?:exec|execSync)\s*\(\s*['"`]git\s/,
    use: 'git() from utils/git-exec',
  },
];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('tool launches go through the runtime layer', () => {
  it('has no direct spawns of detected tool paths or git outside runtime-exec and git-exec', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(MAIN_DIR)) {
      const relative = path.relative(MAIN_DIR, file).split(path.sep).join('/');
      if (ALLOWED.has(relative)) continue;
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        for (const { pattern, use } of FORBIDDEN) {
          if (pattern.test(line)) violations.push(`src/main/${relative}:${index + 1}: ${line.trim()} (use ${use})`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('recognizes the patterns it guards against', () => {
    const samples = [
      "execFileSync(getToolPath('git'), ['status'])",
      "await execFileAsync(getToolPath('gh'), args)",
      "await promisify(execFile)(getToolPath('gh'), args)",
      "spawnSync('git', ['show', ref])",
      "execFileAsync('git', args, { cwd })",
      "execSync('git status')",
    ];
    for (const sample of samples) {
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample)), sample).toBe(true);
    }
    expect(FORBIDDEN.some(({ pattern }) => pattern.test("await git(['status'], { cwd })"))).toBe(false);
    expect(FORBIDDEN.some(({ pattern }) => pattern.test("await runTool('gh', args)"))).toBe(false);
  });
});
