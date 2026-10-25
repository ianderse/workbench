import { useState, useRef, useEffect, useCallback } from 'react';
import { useProjectStore } from '../../../stores/project-store';
import { checkTaskRunning, isIncompleteHumanReview, getTaskProgress, useTaskStore, hasRecentActivity } from '../../../stores/task-store';
import type { ArchivedTaskRun, Task, TaskLogs, TaskLogPhase, WorktreeStatus, ImageAttachment } from '../../../../shared/types';

/**
 * Validates task subtasks structure to prevent infinite loops during resume.
 * Returns true if task has valid subtasks, false otherwise.
 */
function validateTaskSubtasks(task: Task): boolean {
  // Check if subtasks array exists
  if (!task.subtasks || !Array.isArray(task.subtasks)) {
    console.warn('[validateTaskSubtasks] Task has no subtasks array:', task.id);
    return false;
  }

  // If subtasks array is empty and task is incomplete, it needs plan reload
  if (task.subtasks.length === 0) {
    console.warn('[validateTaskSubtasks] Task has empty subtasks array:', task.id);
    return false;
  }

  // Validate each subtask has minimum required fields
  for (let i = 0; i < task.subtasks.length; i++) {
    const subtask = task.subtasks[i];
    if (!subtask || typeof subtask !== 'object') {
      console.warn(`[validateTaskSubtasks] Invalid subtask at index ${i}:`, subtask);
      return false;
    }

    // Title is the primary display field
    if (!subtask.title || typeof subtask.title !== 'string' || subtask.title.trim() === '') {
      console.warn(`[validateTaskSubtasks] Subtask at index ${i} missing title:`, subtask);
      return false;
    }

    // ID is required for tracking
    if (!subtask.id || typeof subtask.id !== 'string') {
      console.warn(`[validateTaskSubtasks] Subtask at index ${i} missing id:`, subtask);
      return false;
    }
  }

  return true;
}

export interface UseTaskDetailOptions {
  task: Task;
}

const LOG_PHASES: TaskLogPhase[] = ['planning', 'coding', 'validation'];

/** Steps whose log ended in failure */
function failedPhases(logs: TaskLogs): Set<TaskLogPhase> {
  return new Set(LOG_PHASES.filter((phase) => logs.phases[phase]?.status === 'failed'));
}

export function useTaskDetail({ task }: UseTaskDetailOptions) {
  const [feedback, setFeedback] = useState('');
  const [feedbackImages, setFeedbackImages] = useState<ImageAttachment[]>([]);
  // "Start over" in Request changes: off by default, so a revision keeps what the task built
  const [startOver, setStartOver] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStuck, setIsStuck] = useState(false);
  const [hasCheckedRunning, setHasCheckedRunning] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [worktreeChangesInfo, setWorktreeChangesInfo] = useState<{ hasChanges: boolean; worktreePath?: string; changedFileCount?: number } | null>(null);
  const [isCheckingChanges, setIsCheckingChanges] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus | null>(null);
  const [phaseLogs, setPhaseLogs] = useState<TaskLogs | null>(null);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  // The runs the task was started over from, oldest first, and which of them are open
  const [previousRuns, setPreviousRuns] = useState<ArchivedTaskRun[]>([]);
  const [openPreviousRuns, setOpenPreviousRuns] = useState<number[]>([]);
  // The Logs section (all steps in one list) opens by itself when a step runs or fails
  const [isLogsExpanded, setIsLogsExpanded] = useState(false);
  const failedPhasesRef = useRef<Set<TaskLogPhase>>(new Set());
  const [isLoadingPlan, setIsLoadingPlan] = useState(false);

  const [showPRDialog, setShowPRDialog] = useState(false);
  const [isCreatingPR, setIsCreatingPR] = useState(false);
  const [showMergePRDialog, setShowMergePRDialog] = useState(false);
  const [showLocalMergeDialog, setShowLocalMergeDialog] = useState(false);

  const currentProject = useProjectStore((state) => {
    const currentProjectId = state.activeProjectId || state.selectedProjectId;
    return currentProjectId
      ? state.projects.find((project) => project.id === currentProjectId)
      : undefined;
  });
  const isRunning = task.status === 'in_progress';
  // isActiveTask includes ai_review for stuck detection (CHANGELOG documents this feature)
  const isActiveTask = task.status === 'in_progress' || task.status === 'ai_review';
  // A task whose PR isn't merged yet is still in review (Human Review column)
  const needsReview = task.status === 'human_review' || task.status === 'pr_created';
  const executionPhase = task.executionProgress?.phase;
  const hasActiveExecution = executionPhase && executionPhase !== 'idle' && executionPhase !== 'complete' && executionPhase !== 'failed';
  const isIncomplete = isIncompleteHumanReview(task);
  const taskProgress = getTaskProgress(task);

  // Catastrophic stuck detection — last-resort safety net.
  // XState handles all normal process-exit transitions via PROCESS_EXITED events.
  // This only fires if XState somehow fails to transition after 60s with no activity.
  useEffect(() => {
    if (!isActiveTask) {
      setIsStuck(false);
      setHasCheckedRunning(false);
      return;
    }

    const checkStuck = () => {
      if (hasRecentActivity(task.id)) {
        setIsStuck(false);
        return;
      }

      // The dialog's own task, so its project is the one that may be running it
      checkTaskRunning(task.id, task.projectId).then((actuallyRunning) => {
        if (hasRecentActivity(task.id)) {
          setIsStuck(false);
        } else {
          setIsStuck(!actuallyRunning);
        }
        setHasCheckedRunning(true);
      });
    };
    // Check right away (a run stopped by quitting the app is stuck as soon as the app starts)
    checkStuck();
    // While stuck, look again often: the app resumes stuck tasks shortly after it starts, and a
    // resumed task keeps its status, so nothing else tells the dialog it runs again
    const intervalId = setInterval(checkStuck, isStuck ? 3_000 : 60_000);

    return () => clearInterval(intervalId);
  }, [task.id, isActiveTask, isStuck]);

  // Check for uncommitted worktree changes when delete dialog opens
  useEffect(() => {
    if (showDeleteDialog && task) {
      setIsCheckingChanges(true);
      window.electronAPI.checkWorktreeChanges(task.id, task.projectId).then((result) => {
        if (result.success && result.data) {
          setWorktreeChangesInfo(result.data);
        }
        setIsCheckingChanges(false);
      }).catch(() => setIsCheckingChanges(false));
    } else {
      setWorktreeChangesInfo(null);
    }
  }, [showDeleteDialog, task]);

  // Reset feedback images when task changes to prevent image leakage between tasks
  useEffect(() => {
    setFeedbackImages([]);
  }, []);

  // Load worktree status when task is in review (change summary, Create PR and Merge PR).
  // Its stats and branches are read against the task's base branch, so editing that branch
  // reads the status again instead of leaving the dialog on the branch it opened with
  const taskBaseBranch = task.metadata?.baseBranch;
  useEffect(() => {
    if (needsReview) {
      window.electronAPI.getWorktreeStatus(task.id, task.projectId).then((statusResult) => {
        if (statusResult.success && statusResult.data) {
          setWorktreeStatus(statusResult.data);
        }
      }).catch((err) => {
        console.error('Failed to load worktree info:', err);
      });
    } else {
      setWorktreeStatus(null);
    }
  }, [task.id, task.projectId, needsReview, taskBaseBranch]);

  // The task's earlier runs. Loaded once; starting the task over adds one, so the dialog
  // reloads them after a retry (reloadPreviousRuns) rather than polling
  const reloadPreviousRuns = useCallback(async () => {
    if (!currentProject) return;
    try {
      const result = await window.electronAPI.getPreviousTaskRuns(currentProject.id, task.specId);
      if (result.success && result.data) setPreviousRuns(result.data);
    } catch (err) {
      console.error('Failed to load the previous runs:', err);
    }
  }, [currentProject, task.specId]);

  useEffect(() => {
    void reloadPreviousRuns();
  }, [reloadPreviousRuns]);

  const togglePreviousRun = useCallback((index: number) => {
    setOpenPreviousRuns((open) => (open.includes(index) ? open.filter((i) => i !== index) : [...open, index]));
  }, []);

  // Load and watch phase logs
  useEffect(() => {
    if (!currentProject) return;

    const loadLogs = async () => {
      setIsLoadingLogs(true);
      try {
        const result = await window.electronAPI.getTaskLogs(currentProject.id, task.specId);
        if (result.success && result.data) {
          setPhaseLogs(result.data);
          // Open the logs while a step runs or after one failed (so its error is visible)
          const data = result.data;
          failedPhasesRef.current = failedPhases(data);
          if (failedPhasesRef.current.size > 0 || LOG_PHASES.some((phase) => data.phases[phase]?.status === 'active')) {
            setIsLogsExpanded(true);
          }
        }
      } catch (err) {
        console.error('Failed to load task logs:', err);
      } finally {
        setIsLoadingLogs(false);
      }
    };

    loadLogs();

    // Start watching for log changes
    window.electronAPI.watchTaskLogs(currentProject.id, task.specId);

    // Listen for log changes
    const unsubscribe = window.electronAPI.onTaskLogsChanged((specId, logs, projectId) => {
      // Spec ids repeat across projects, so the project decides whose logs these are
      if (specId === task.specId && (!projectId || projectId === currentProject.id)) {
        setPhaseLogs(logs);
        // Open the logs when a step newly fails (a collapsed list stays collapsed otherwise)
        const failed = failedPhases(logs);
        if ([...failed].some((phase) => !failedPhasesRef.current.has(phase))) {
          setIsLogsExpanded(true);
        }
        failedPhasesRef.current = failed;
      }
    });

    return () => {
      unsubscribe();
      window.electronAPI.unwatchTaskLogs(currentProject.id, task.specId);
    };
  }, [currentProject, task.specId]);

  const toggleLogs = useCallback(() => setIsLogsExpanded((open) => !open), []);

  // Add a feedback image
  const addFeedbackImage = useCallback((image: ImageAttachment) => {
    setFeedbackImages(prev => [...prev, image]);
  }, []);

  // Add multiple feedback images at once
  const addFeedbackImages = useCallback((images: ImageAttachment[]) => {
    setFeedbackImages(prev => [...prev, ...images]);
  }, []);

  // Remove a feedback image by ID
  const removeFeedbackImage = useCallback((imageId: string) => {
    setFeedbackImages(prev => prev.filter(img => img.id !== imageId));
  }, []);

  // Clear all feedback images
  const clearFeedbackImages = useCallback(() => {
    setFeedbackImages([]);
  }, []);

  /**
   * Reloads implementation plan for an incomplete task to ensure subtasks are properly loaded.
   * This prevents the "Task Incomplete" infinite loop when resuming stuck tasks.
   */
  const reloadPlanForIncompleteTask = useCallback(async (): Promise<boolean> => {
    if (!currentProject) {
      console.error('[reloadPlanForIncompleteTask] No current project');
      return false;
    }

    // Only reload if task is incomplete and subtasks are invalid
    if (!isIncomplete) {
      return true; // Not incomplete, no reload needed
    }

    // Check if subtasks are valid
    if (validateTaskSubtasks(task)) {
      console.log('[reloadPlanForIncompleteTask] Subtasks are valid, no reload needed');
      return true; // Subtasks are valid, proceed
    }

    console.warn('[reloadPlanForIncompleteTask] Task has invalid subtasks, reloading plan:', {
      taskId: task.id,
      specId: task.specId,
      subtaskCount: task.subtasks?.length || 0
    });

    setIsLoadingPlan(true);
    try {
      // Reload tasks from the project to get fresh implementation plan
      const result = await window.electronAPI.getTasks(currentProject.id);

      if (!result.success || !result.data) {
        console.error('[reloadPlanForIncompleteTask] Failed to reload tasks:', result.error);
        return false;
      }

      // Find the updated task in the result
      const updatedTask = result.data.find(t => t.id === task.id || t.specId === task.specId);
      if (!updatedTask) {
        console.error('[reloadPlanForIncompleteTask] Task not found in reloaded tasks');
        return false;
      }

      // Validate the reloaded subtasks
      if (!validateTaskSubtasks(updatedTask)) {
        console.error('[reloadPlanForIncompleteTask] Reloaded task still has invalid subtasks');
        return false;
      }

      console.log('[reloadPlanForIncompleteTask] Successfully reloaded plan with valid subtasks:', {
        taskId: task.id,
        subtaskCount: updatedTask.subtasks?.length ?? 0
      });

      // FIX (PR Review): Update the Zustand store with the reloaded task data
      // Without this, the UI continues to display stale/invalid subtasks
      const store = useTaskStore.getState();
      store.updateTask(task.id, {
        subtasks: updatedTask.subtasks,
        title: updatedTask.title,
        description: updatedTask.description,
        metadata: updatedTask.metadata,
        updatedAt: new Date()
      });

      return true;
    } catch (err) {
      console.error('[reloadPlanForIncompleteTask] Error reloading plan:', err);
      return false;
    } finally {
      setIsLoadingPlan(false);
    }
  }, [currentProject, task, isIncomplete]);

  return {
    // State
    feedback,
    feedbackImages,
    startOver,
    isSubmitting,
    isStuck,
    hasCheckedRunning,
    showDeleteDialog,
    isDeleting,
    deleteError,
    worktreeChangesInfo,
    isCheckingChanges,
    isEditDialogOpen,
    worktreeStatus,
    phaseLogs,
    isLoadingLogs,
    previousRuns,
    openPreviousRuns,
    isLogsExpanded,
    selectedProject: currentProject,
    isRunning,
    needsReview,
    executionPhase,
    hasActiveExecution,
    isIncomplete,
    taskProgress,
    showPRDialog,
    isCreatingPR,
    showMergePRDialog,
    showLocalMergeDialog,
    isLoadingPlan,

    // Setters
    setFeedback,
    setFeedbackImages,
    setStartOver,
    setIsSubmitting,
    setIsStuck,
    setHasCheckedRunning,
    setShowDeleteDialog,
    setIsDeleting,
    setDeleteError,
    setWorktreeChangesInfo,
    setIsCheckingChanges,
    setIsEditDialogOpen,
    setWorktreeStatus,
    setPhaseLogs,
    setIsLoadingLogs,
    setShowPRDialog,
    setIsCreatingPR,
    setShowMergePRDialog,
    setShowLocalMergeDialog,

    // Handlers
    toggleLogs,
    togglePreviousRun,
    reloadPreviousRuns,
    addFeedbackImage,
    addFeedbackImages,
    removeFeedbackImage,
    clearFeedbackImages,
    reloadPlanForIncompleteTask,
  };
}
