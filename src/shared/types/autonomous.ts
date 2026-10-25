/** Autonomous mode: what the board shows and what its actions return */

/** The integration branch's state next to the base branch (the "finish line" banner) */
export interface AutonomousStatus {
  enabled: boolean;
  target: 'integration' | 'main';
  /** The branch tasks merge into */
  branch: string;
  /** The project's base branch */
  baseBranch: string;
  /** Whether the target branch exists yet (the integration branch is created when first needed) */
  branchExists: boolean;
  /** Tasks the integration branch holds that the base branch does not (integration target only) */
  ahead: number;
  push: boolean;
}

export interface AutonomousMergeIntoBaseResult {
  merged: boolean;
  alreadyUpToDate?: boolean;
  sha?: string;
  pushed?: boolean;
  /** The push failed or was skipped; the merge itself stands */
  pushError?: string;
  conflictedFiles?: string[];
}

/** Later automatically merged tasks that depend on a task about to be reverted */
export interface AutonomousRevertPreview {
  dependents: Array<{ id: string; title: string }>;
}

export interface AutonomousRevertResult {
  sha: string;
  pushed?: boolean;
  pushError?: string;
}
