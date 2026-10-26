import { describe, expect, it } from 'vitest';
import { sanitizeChangedFiles, toRepoPath } from '../changed-files';
import { resolveMergeBaseDuring } from '../merge-base-timing';

describe('sanitizeChangedFiles', () => {
  it('drops OMP pseudo targets and keeps real repo-relative paths', () => {
    expect(sanitizeChangedFiles([
      'src/a.ts', 'agent:/IntCli040', 'conflict:/1', 'conflict:/*', 'local://notes.md', 'C:\\proj\\x.ts',
      '/etc/passwd', '../outside.ts', 'src/../b.ts', '', '  ', 'dir//file.ts', 'src/*.ts', 'README.md',
    ])).toEqual(['src/a.ts', 'README.md']);
  });

  it('normalizes separators and leading ./, and removes duplicates', () => {
    expect(sanitizeChangedFiles(['./src/a.ts', 'src\\a.ts', 'src/a.ts', 'src/[id]/page.tsx'])).toEqual(['src/a.ts', 'src/[id]/page.tsx']);
  });

  it('ignores non-strings and a missing list', () => {
    expect(sanitizeChangedFiles([1, null, undefined, 'a.ts'] as unknown[])).toEqual(['a.ts']);
    expect(sanitizeChangedFiles(undefined)).toEqual([]);
    expect(toRepoPath('agent:/x')).toBeUndefined();
  });
});

describe('resolveMergeBaseDuring', () => {
  it('defaults to validate and honors immediately', () => {
    expect(resolveMergeBaseDuring(undefined)).toBe('validate');
    expect(resolveMergeBaseDuring({})).toBe('validate');
    expect(resolveMergeBaseDuring({ mergeBaseDuring: 'immediately' })).toBe('immediately');
  });
});
