import type { ReviewRoundFinding } from './claude-code';

export interface HumanWorkSnapshot {
  revision: number;
  owner: string;
  status: 'open' | 'in_progress' | 'submitted';
  response: string;
  /** References to artifacts or participant notes, entered by the person; never machine verification. */
  evidence: string;
  at: string;
}
export interface HumanWorkItem extends HumanWorkSnapshot {
  id: string;
  finding: ReviewRoundFinding;
  createdAt: string;
  history: HumanWorkSnapshot[];
}
export interface HumanApprovalOverride {
  scope: 'task-human-approval';
  approver: string;
  reason: string;
  at: string;
  revision: number;
}
export interface HumanWorkstream {
  revision: number;
  items: HumanWorkItem[];
  approvalOverride?: HumanApprovalOverride;
  overrideHistory?: HumanApprovalOverride[];
}
export type HumanWorkMutation =
  | { action: 'override'; expectedRevision: number; approver: string; reason: string }
  | { action: 'create'; expectedRevision: number; finding: ReviewRoundFinding }
  | { action: 'update'; expectedRevision: number; id: string; relatedIds?: string[]; owner: string; status: HumanWorkSnapshot['status']; response: string; evidence: string };

export interface HumanReviewArtifact {
  path: string;
  label: string;
  kind: 'report' | 'protocol' | 'gallery' | 'asset' | 'other';
  available: boolean;
  directory?: boolean;
  imageCount?: number;
}
export interface HumanReviewPacket {
  root: string;
  location: 'worktree' | 'project';
  artifacts: HumanReviewArtifact[];
  /** Quoted from the report, never an independent assessment of delivered art. */
  limitations?: string;
}
