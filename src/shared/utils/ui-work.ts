/**
 * UI work: tasks that involve frontend / UI get a design spec from the design model.
 * Pure helpers shared by the main process (runner) and the renderer (card, detail).
 */

import type { ProjectSettings } from '../types/project';

export type UiImplementer = 'design' | 'default';

/** Whether a task counts as UI work: the ticket's own choice (true/false) wins, else triage's, else false */
export function resolveUiWork(override: boolean | undefined, triageUiWork: boolean | undefined): boolean {
  if (typeof override === 'boolean') return override;
  return triageUiWork === true;
}

/** Who builds UI work (project setting `uiImplementer`, default: the design model) */
export function resolveUiImplementer(settings: Pick<ProjectSettings, 'uiImplementer'> | undefined): UiImplementer {
  return settings?.uiImplementer === 'default' ? 'default' : 'design';
}

/** Steps of a run; the design model takes some of them on UI work */
export type UiPhase = 'plan' | 'implement' | 'revise' | 'validate' | 'resync' | 'review' | 'spec_review';

/**
 * Whether a step of a UI task runs on the design model. The plan step always does; implement, revise and
 * validate (the same session) do when the design model builds the task. Not for non-UI tasks, resync,
 * the OMP fresh-context review or spec reviews.
 */
export function usesDesignModel(phase: UiPhase, uiWork: boolean, implementer: UiImplementer): boolean {
  if (!uiWork) return false;
  if (phase === 'plan') return true;
  if (phase === 'implement' || phase === 'revise' || phase === 'validate') return implementer === 'design';
  return false;
}

/** Whether a task is shown as UI work: the ticket's own choice, else the triage of its run */
export function isUiTask(task: { metadata?: { uiWork?: boolean }; claudeRun?: { triage?: { uiWork?: boolean } } }): boolean {
  return resolveUiWork(task.metadata?.uiWork, task.claudeRun?.triage?.uiWork);
}
