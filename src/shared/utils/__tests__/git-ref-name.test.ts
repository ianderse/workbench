import { describe, it, expect } from 'vitest';
import { checkBranchNameSyntax, validateNewBranchName } from '../git-ref-name';

describe('checkBranchNameSyntax', () => {
  it.each(['feature', 'feature/login', 'release-1.2', 'a_b/c-d', 'fix/ISSUE-12', 'v1.0.0'])('accepts %s', (name) => {
    expect(checkBranchNameSyntax(name)).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['my branch', 'spaces'],
    ['tab\tname', 'spaces'],
    ['a..b', 'doubleDots'],
    ['-start', 'leadingDash'],
    ['/start', 'leadingSlash'],
    ['end/', 'trailingSlash'],
    ['end.', 'trailingDot'],
    ['name.lock', 'trailingLock'],
    ['dir.lock/name', 'trailingLock'],
    ['a//b', 'doubleSlash'],
    ['a/.hidden', 'leadingDot'],
    ['a@{b', 'atBrace'],
    ['@', 'reserved'],
    ['HEAD', 'reserved'],
    ['a~b', 'invalidChars'],
    ['a^b', 'invalidChars'],
    ['a:b', 'invalidChars'],
    ['a?b', 'invalidChars'],
    ['a*b', 'invalidChars'],
    ['a[b', 'invalidChars'],
    ['a\\b', 'invalidChars'],
    ['a\u0001b', 'invalidChars'],
  ])('rejects %j as %s', (name, error) => {
    expect(checkBranchNameSyntax(name)).toBe(error);
  });
});

describe('validateNewBranchName', () => {
  const existing = ['main', 'develop', 'feature/login'];

  it('accepts a free name', () => {
    expect(validateNewBranchName('feature/signup', existing)).toBeNull();
  });

  it('rejects a name a branch already has', () => {
    expect(validateNewBranchName('develop', existing)).toBe('exists');
  });

  it('rejects a name that is a folder of an existing branch, or inside one', () => {
    expect(validateNewBranchName('feature', existing)).toBe('conflicts');
    expect(validateNewBranchName('main/sub', existing)).toBe('conflicts');
  });

  it('reports syntax errors first', () => {
    expect(validateNewBranchName('bad name', existing)).toBe('spaces');
  });
});
