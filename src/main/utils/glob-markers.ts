/**
 * Matches a file name against a simple `*.ext` glob, the only shape the project
 * marker patterns use. Follows glob convention: a leading `*` never matches a
 * dot file, so `.csproj` is not a match for `*.csproj`.
 *
 * Callers reject patterns containing `..` or a path separator before getting here.
 */
export function matchesExtensionGlob(fileName: string, pattern: string): boolean {
  if (!pattern.startsWith('*.') || fileName.startsWith('.')) {
    return false;
  }
  const suffix = pattern.slice(1); // '*.csproj' -> '.csproj'
  return fileName.length > suffix.length
    && fileName.toLowerCase().endsWith(suffix.toLowerCase());
}
