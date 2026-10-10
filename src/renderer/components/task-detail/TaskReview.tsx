import type { Task, WorktreeStatus, MergeConflict, MergeStats, GitConflictInfo, ImageAttachment, WorktreeCreatePRResult } from '../../../shared/types';
import {
  StagedSuccessMessage,
  WorkspaceStatus,
  QAFeedbackSection,
  ConflictDetailsDialog,
  LoadingMessage,
  NoWorkspaceMessage,
  StagedInProjectMessage,
  CreatePRDialog
} from './task-review';

interface TaskReviewProps {
  task: Task;
  feedback: string;
  isSubmitting: boolean;
  worktreeStatus: WorktreeStatus | null;
  isLoadingWorktree: boolean;
  isMerging: boolean;
  workspaceError: string | null;
  stageOnly: boolean;
  stagedSuccess: string | null;
  stagedProjectPath: string | undefined;
  suggestedCommitMessage: string | undefined;
  mergePreview: { files: string[]; conflicts: MergeConflict[]; summary: MergeStats; gitConflicts?: GitConflictInfo; uncommittedChanges?: { hasChanges: boolean; files: string[]; count: number } | null } | null;
  isLoadingPreview: boolean;
  showConflictDialog: boolean;
  onFeedbackChange: (value: string) => void;
  onReject: () => void;
  /** Image attachments for visual feedback */
  images?: ImageAttachment[];
  /** Callback when images change */
  onImagesChange?: (images: ImageAttachment[]) => void;
  onMerge: () => void;
  onStageOnlyChange: (value: boolean) => void;
  onShowConflictDialog: (show: boolean) => void;
  onLoadMergePreview: () => void;
  onClose?: () => void;
  onReviewAgain?: () => void;
  // PR creation
  showPRDialog: boolean;
  isCreatingPR: boolean;
  onShowPRDialog: (show: boolean) => void;
  onCreatePR: (options: { targetBranch?: string; title?: string; draft?: boolean }) => Promise<WorktreeCreatePRResult | null>;
}

/**
 * TaskReview Component
 *
 * Main component for reviewing task completion, displaying workspace status,
 * merge previews, and providing options to merge, stage, or create a pull request.
 *
 * This component has been refactored into smaller, focused sub-components for better
 * maintainability. See ./task-review/ directory for individual component implementations.
 */
export function TaskReview({
  task,
  feedback,
  isSubmitting,
  worktreeStatus,
  isLoadingWorktree,
  isMerging,
  workspaceError,
  stageOnly,
  stagedSuccess,
  stagedProjectPath,
  suggestedCommitMessage,
  mergePreview,
  isLoadingPreview,
  showConflictDialog,
  onFeedbackChange,
  onReject,
  images,
  onImagesChange,
  onMerge,
  onStageOnlyChange,
  onShowConflictDialog,
  onLoadMergePreview,
  onClose,
  onReviewAgain,
  showPRDialog,
  isCreatingPR,
  onShowPRDialog,
  onCreatePR
}: TaskReviewProps) {
  const showsWorkspace = !isLoadingWorktree && !stagedSuccess && !task.stagedInMainProject && !!worktreeStatus?.exists;
  const feedbackSection = (
    <QAFeedbackSection
      feedback={feedback}
      isSubmitting={isSubmitting}
      onFeedbackChange={onFeedbackChange}
      onReject={onReject}
      images={images}
      onImagesChange={onImagesChange}
    />
  );

  return (
    <div className="space-y-6">

      {/* Workspace Status - priority: loading > staged fresh > staged persisted > worktree exists > no workspace */}
      {isLoadingWorktree ? (
        <LoadingMessage />
      ) : stagedSuccess ? (
        /* Fresh staging success - show commit message and next steps */
        <StagedSuccessMessage
          stagedSuccess={stagedSuccess}
          suggestedCommitMessage={suggestedCommitMessage}
          task={task}
          hasWorktree={worktreeStatus?.exists || false}
          projectPath={stagedProjectPath}
          onClose={onClose}
          onReviewAgain={onReviewAgain}
        />
      ) : task.stagedInMainProject ? (
        /* Previously staged (persisted) - show action buttons */
        <StagedInProjectMessage
          task={task}
          projectPath={stagedProjectPath}
          hasWorktree={worktreeStatus?.exists || false}
          onClose={onClose}
          onReviewAgain={onReviewAgain}
        />
      ) : worktreeStatus?.exists ? (
        /* Worktree exists but not yet staged - show staging UI */
        <WorkspaceStatus
          taskId={task.id}
          worktreeStatus={worktreeStatus}
          workspaceError={workspaceError}
          stageOnly={stageOnly}
          mergePreview={mergePreview}
          isLoadingPreview={isLoadingPreview}
          isMerging={isMerging}
          onShowConflictDialog={onShowConflictDialog}
          onLoadMergePreview={onLoadMergePreview}
          onStageOnlyChange={onStageOnlyChange}
          onMerge={onMerge}
          beforeActions={feedbackSection}
        />
      ) : (
        <NoWorkspaceMessage task={task} onClose={onClose} />
      )}

      {/* Request changes (inside the workspace section when a worktree exists, so its
          check-for-conflicts / create PR / merge buttons stay at the bottom) */}
      {!showsWorkspace && feedbackSection}

      {/* Conflict Details Dialog */}
      <ConflictDetailsDialog
        open={showConflictDialog}
        mergePreview={mergePreview}
        stageOnly={stageOnly}
        onOpenChange={onShowConflictDialog}
        onMerge={onMerge}
      />

      {/* Create PR Dialog */}
      <CreatePRDialog
        open={showPRDialog}
        task={task}
        worktreeStatus={worktreeStatus}
        onOpenChange={onShowPRDialog}
        onCreatePR={onCreatePR}
      />
    </div>
  );
}
