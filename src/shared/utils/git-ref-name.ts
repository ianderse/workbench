/**
 * Branch name rules (git check-ref-format --branch), checked without running git so the task
 * dialog can validate a new base branch name while the user types.
 */

export type BranchNameError =
  | 'empty'
  | 'spaces'
  | 'invalidChars'
  | 'doubleDots'
  | 'doubleSlash'
  | 'leadingDash'
  | 'leadingSlash'
  | 'trailingSlash'
  | 'trailingDot'
  | 'trailingLock'
  | 'leadingDot'
  | 'atBrace'
  | 'reserved'
  | 'exists'
  | 'conflicts';

/** Characters git refuses anywhere in a ref name (control characters are checked separately) */
const FORBIDDEN_CHARS = /[~^:?*[\\]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The first rule a branch name breaks (ignoring other branches), or null when git accepts it */
export function checkBranchNameSyntax(name: string): BranchNameError | null {
  if (name.length === 0) return 'empty';
  if (/\s/.test(name)) return 'spaces';
  if (CONTROL_CHARS.test(name) || FORBIDDEN_CHARS.test(name)) return 'invalidChars';
  if (name === '@' || name === 'HEAD') return 'reserved';
  if (name.includes('..')) return 'doubleDots';
  if (name.includes('@{')) return 'atBrace';
  if (name.startsWith('-')) return 'leadingDash';
  if (name.startsWith('/')) return 'leadingSlash';
  if (name.includes('//')) return 'doubleSlash';
  if (name.endsWith('/')) return 'trailingSlash';
  if (name.endsWith('.')) return 'trailingDot';
  const parts = name.split('/');
  if (parts.some((part) => part.endsWith('.lock'))) return 'trailingLock';
  if (parts.some((part) => part.startsWith('.'))) return 'leadingDot';
  return null;
}

/**
 * The first reason `name` cannot be a new branch next to `existing`, or null. A name is taken when
 * a branch has it, and also when one of them is a folder prefix of the other (`feature` and
 * `feature/login` cannot both exist).
 */
export function validateNewBranchName(name: string, existing: readonly string[]): BranchNameError | null {
  const syntax = checkBranchNameSyntax(name);
  if (syntax) return syntax;
  if (existing.includes(name)) return 'exists';
  if (existing.some((other) => other.startsWith(`${name}/`) || name.startsWith(`${other}/`))) return 'conflicts';
  return null;
}
