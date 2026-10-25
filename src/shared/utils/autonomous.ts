/**
 * Autonomous mode: the pure rules
 * ===============================
 *
 * With the project setting `autonomous` on, a task that passes the AI review is merged into a
 * target branch by the app (one `--no-ff` merge commit), the tasks waiting on it start, and the
 * task waits in Human Review (reason `auto_merged`) for a person to sign it off. Nothing here
 * touches git or the disk: the main process does the work, this module decides.
 */
import type { AutoMergeRecord, ProjectSettings, Task } from '../types';

export const DEFAULT_AUTONOMOUS_BRANCH = 'workbench/auto';

/** A valid branch name for the integration branch (same rule the app uses for task base branches) */
const BRANCH_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

export interface AutonomousConfig {
  enabled: boolean;
  /** 'integration': merge into a separate branch; 'main': merge into the project's base branch */
  target: 'integration' | 'main';
  /** The integration branch (also kept for 'main', so switching back keeps the name) */
  integrationBranch: string;
  push: boolean;
}

type AutonomousSettings = Pick<ProjectSettings, 'autonomous' | 'autonomousTarget' | 'autonomousBranch' | 'autonomousPush'>;

export function resolveAutonomousConfig(settings: Partial<AutonomousSettings> | undefined): AutonomousConfig {
  const branch = settings?.autonomousBranch?.trim();
  return {
    enabled: settings?.autonomous === true,
    target: settings?.autonomousTarget === 'main' ? 'main' : 'integration',
    integrationBranch: branch && BRANCH_NAME.test(branch) && !branch.includes('..') ? branch : DEFAULT_AUTONOMOUS_BRANCH,
    push: settings?.autonomousPush !== false,
  };
}

/**
 * The branch tasks start from and merge into while autonomous mode is on, or undefined when it is
 * off. `baseBranch` is the project's base branch (used for the 'main' target).
 */
export function getAutonomousTargetBranch(config: AutonomousConfig, baseBranch: string | undefined): string | undefined {
  if (!config.enabled) return undefined;
  return config.target === 'integration' ? config.integrationBranch : baseBranch || undefined;
}

/** A branch name without the `origin/` prefix */
function localName(branch: string): string {
  return branch.replace(/^origin\//, '');
}

/**
 * The base branch the user chose for a task that autonomous mode leaves alone, or undefined when the
 * task follows the autonomous target. Explicit means: autonomous mode is on, the task has a worktree,
 * `metadata.baseBranchChosen` is set (the dialogs set it for any branch but "Project default"; tasks
 * without it keep following the target) and the branch is neither the project's default branch nor
 * the integration branch. Such a task is cut from that branch and auto-merged into it.
 * `defaultBranches` are the project's default branch names that are known where this is called.
 */
export function getExplicitBaseBranch(
  config: AutonomousConfig,
  task: Pick<Task, 'metadata'>,
  defaultBranches: ReadonlyArray<string | undefined> = [],
): string | undefined {
  if (!config.enabled) return undefined;
  const metadata = task.metadata;
  if (!metadata?.baseBranchChosen || metadata.useWorktree === false) return undefined;
  const branch = metadata.baseBranch ? localName(metadata.baseBranch) : '';
  if (!branch || branch === '__project_default__' || branch === config.integrationBranch) return undefined;
  if (defaultBranches.some((d) => d && localName(d) === branch)) return undefined;
  return branch;
}

export interface AutoMergeCandidate {
  /** Board status and review reason when the task entered Human Review */
  status: Task['status'];
  reviewReason?: Task['reviewReason'];
  /** The run's AI review verdict (`ClaudeRunInfo.reviewVerdict`); none when validation is off */
  verdictStatus?: 'passed' | 'failed';
  /** The task already has an automatic merge that was not reverted */
  alreadyMerged?: boolean;
  /** The user stopped the task */
  stopped?: boolean;
}

export type AutoMergeDecision = { eligible: true } | { eligible: false; reason: string };

/**
 * Whether a task that just reached Human Review is merged automatically. Only a finished run
 * (reason `completed`) that passed AI review qualifies: with validation off there is no verdict
 * and nothing was reviewed, a failed verdict is never merged, and a stopped task is the user's.
 */
export function decideAutoMerge(config: AutonomousConfig, task: AutoMergeCandidate): AutoMergeDecision {
  if (!config.enabled) return { eligible: false, reason: 'autonomous mode is off' };
  if (task.stopped || task.reviewReason === 'stopped') return { eligible: false, reason: 'the task was stopped' };
  if (task.status !== 'human_review' || task.reviewReason !== 'completed') {
    return { eligible: false, reason: 'the task is not waiting for review as completed' };
  }
  if (task.alreadyMerged) return { eligible: false, reason: 'the task was already merged automatically' };
  if (task.verdictStatus === 'failed') return { eligible: false, reason: 'the AI review failed' };
  if (task.verdictStatus !== 'passed') return { eligible: false, reason: 'the task has no passed AI review' };
  return { eligible: true };
}

/** The task's automatic merge when it still stands (not reverted) */
export function activeAutoMerge(task: Pick<Task, 'metadata'>): AutoMergeRecord | undefined {
  const record = task.metadata?.autoMerge;
  return record && !record.revertedAt ? record : undefined;
}

/** Matches any target branch: a project whose tasks branch from its default base branch */
export const ANY_TARGET_BRANCH = '*';

/**
 * Whether a dependency counts as satisfied for a queued task. `done` always does; in autonomous
 * mode so does a dependency merged automatically into the branch the dependent will branch from
 * (`dependentTarget`, undefined while autonomous mode is off).
 */
export function isDependencySatisfied(dep: Pick<Task, 'status' | 'metadata'>, dependentTarget: string | undefined): boolean {
  if (dep.status === 'done') return true;
  if (!dependentTarget) return false;
  const merged = activeAutoMerge(dep);
  if (!merged) return false;
  if (dependentTarget === ANY_TARGET_BRANCH) {
    // The dependent follows the shared target (main / integration branch). A dependency on a branch of
    // its own was merged into that branch, not into the shared target, so it is still pending
    return !dep.metadata?.baseBranchChosen;
  }
  return merged.branch === dependentTarget;
}

/**
 * The target to check dependencies against when the project's settings are not at hand (the
 * board): the dependent's own chosen branch, else any shared target
 */
export function dependentTargetHint(task: Pick<Task, 'metadata'>): string {
  const metadata = task.metadata;
  return metadata?.baseBranchChosen && metadata.baseBranch && metadata.useWorktree !== false
    ? localName(metadata.baseBranch)
    : ANY_TARGET_BRANCH;
}

/** Tasks that were auto-merged and depend on `task`, directly or through other tasks */
export function findAutoMergedDependents(task: Pick<Task, 'id'>, tasks: readonly Task[]): Task[] {
  const result: Task[] = [];
  const seen = new Set<string>([task.id]);
  const queue = [task.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const other of tasks) {
      if (seen.has(other.id)) continue;
      if (!(other.metadata?.dependsOnTaskIds ?? []).includes(id)) continue;
      seen.add(other.id);
      queue.push(other.id);
      if (activeAutoMerge(other)) result.push(other);
    }
  }
  return result;
}
