import { describe, it, expect } from 'vitest';
import { matchesExtensionGlob } from '../glob-markers';

describe('matchesExtensionGlob', () => {
  it('matches a file with the pattern extension', () => {
    expect(matchesExtensionGlob('App.csproj', '*.csproj')).toBe(true);
    expect(matchesExtensionGlob('Foo.Bar.fsproj', '*.fsproj')).toBe(true);
  });

  it('ignores case in both name and pattern', () => {
    expect(matchesExtensionGlob('app.CSPROJ', '*.csproj')).toBe(true);
    expect(matchesExtensionGlob('UPPER.SLN', '*.sln')).toBe(true);
  });

  it('rejects a different extension', () => {
    expect(matchesExtensionGlob('README.md', '*.csproj')).toBe(false);
    expect(matchesExtensionGlob('a.csproj.bak', '*.csproj')).toBe(false);
  });

  it('never matches a dot file, the way a leading * does not', () => {
    expect(matchesExtensionGlob('.csproj', '*.csproj')).toBe(false);
    expect(matchesExtensionGlob('.hidden.sln', '*.sln')).toBe(false);
  });

  it('requires a name before the extension', () => {
    expect(matchesExtensionGlob('csproj', '*.csproj')).toBe(false);
    expect(matchesExtensionGlob('', '*.csproj')).toBe(false);
  });

  it('rejects a pattern that is not a *.ext glob', () => {
    expect(matchesExtensionGlob('App.csproj', 'App.csproj')).toBe(false);
    expect(matchesExtensionGlob('App.csproj', '*')).toBe(false);
  });
});
