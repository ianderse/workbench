/**
 * TaskCreationWizard - Dialog for creating new tasks
 *
 * Now uses the shared TaskModalLayout for consistent styling with other task modals,
 * and TaskFormFields for the form content.
 *
 * Features unique to creation (not in TaskEditDialog):
 * - Draft persistence (auto-save to localStorage)
 * - File explorer drawer sidebar
 * - Git branch selection options
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button, buttonVariants } from './ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { TaskModalLayout } from './task-form/TaskModalLayout';
import { TaskFormFields } from './task-form/TaskFormFields';
import { PROJECT_DEFAULT_BRANCH, TaskGitOptionsSection, useTaskGitOptions } from './task-form/TaskGitOptions';
import { buildBaseBranchMetadata, isBaseBranchChoiceValid } from './task-form/base-branch-metadata';
import { createTask, queueTasksInOrder, saveDraft, loadDraft, clearDraft, isDraftEmpty, useTaskStore, type TaskCreationDraft } from '../stores/task-store';
import type { PendingBreakdownReview } from '../stores/breakdown-review-store';
import { listOpenTickets } from '../../shared/utils/open-tickets';
import type { TaskMetadata, ImageAttachment, AgentOverride } from '../../shared/types';
import { normalizeAgentOverride } from '../../shared/utils/agent-override';
import { useSettingsStore } from '../stores/settings-store';
import { TaskBreakdownReview, effectiveDependencies, effectiveExistingDependencies, type BreakdownItem } from './task-form/TaskBreakdownReview';
import type { RunProgress } from '../../shared/utils/run-progress';
import { BreakdownWorking } from './task-form/BreakdownWorking';
import type { OpenTicketRef, TaskBreakdown } from '../../shared/types/task-breakdown';
import { sortByDependencies } from '../../shared/utils/task-breakdown-order';
import { getDefaultMcpConnectorIds } from '../../shared/utils/mcp-connectors';

interface TaskCreationWizardProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A stored Break into tasks proposal to review: the dialog opens on its review step */
  initialBreakdown?: PendingBreakdownReview | null;
  /** Called once the dialog took `initialBreakdown` */
  onBreakdownConsumed?: () => void;
}

/** A breakdown running longer than this asks before it is stopped */
const LONG_BREAKDOWN_MS = 30_000;

export function TaskCreationWizard({
  projectId,
  open,
  onOpenChange,
  initialBreakdown,
  onBreakdownConsumed
}: TaskCreationWizardProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { settings } = useSettingsStore();

  // Form state
  const [description, setDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Git options state - using structured GitBranchDetail for type indicators
  const [baseBranch, setBaseBranch] = useState<string>(PROJECT_DEFAULT_BRANCH);
  // "New branch": the name to create and the branch it starts from
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchFrom, setNewBranchFrom] = useState<string>(PROJECT_DEFAULT_BRANCH);
  // Worktree isolation - default to true for safety
  const [useWorktree, setUseWorktree] = useState(true);
  const [pushNewBranches, setPushNewBranches] = useState(true);

  // The project's branches (the shared list, no git calls when the dialog opens) and its own
  // git defaults, shared with the edit dialog
  const gitOptions = useTaskGitOptions(projectId);
  const { projectDefaultBranch, projectPushNewBranches } = gitOptions;

  // A new branch needs a legal, unused name and a branch to start from before the task can be created
  const baseBranchChoice = {
    baseBranch,
    newBranchName,
    newBranchFrom,
    projectDefaultBranch,
    isLocalBranch: gitOptions.isLocalBranch,
  };
  const isBaseBranchValid = isBaseBranchChoiceValid(baseBranchChoice, gitOptions.branchNames);

  // Images
  const [images, setImages] = useState<ImageAttachment[]>([]);

  // MCP connectors start from the Connectors defaults; changes stay with this task
  const defaultConnectors = useMemo(() => getDefaultMcpConnectorIds(settings.mcpConnectors), [settings.mcpConnectors]);
  const [mcpConnectors, setMcpConnectors] = useState<string[]>(defaultConnectors);

  // Model and effort pinned on the task (unset = triage decides)
  const [agentOverride, setAgentOverride] = useState<AgentOverride | undefined>(undefined);
  const [uiWork, setUiWork] = useState<boolean | undefined>(undefined);

  // "Break into tasks": 'form' -> 'working' (model call) -> 'review' -> creating
  const [step, setStep] = useState<'form' | 'working' | 'review'>('form');
  const [breakdownItems, setBreakdownItems] = useState<BreakdownItem[]>([]);
  const [openTickets, setOpenTickets] = useState<OpenTicketRef[]>([]);
  const [breakdownProgress, setBreakdownProgress] = useState<RunProgress | null>(null);
  const [queueAfterCreate, setQueueAfterCreate] = useState(true);
  const breakdownRequestId = useRef<string | null>(null);
  // The spec batch of the breakdown under review (Spec review loop)
  const specBatch = useRef<{ id: string; sources: string[]; prompt: string } | null>(null);
  const breakdownStartedAt = useRef(0);
  // The stored proposal being reviewed (dismissed once its tickets are created or discarded)
  const reviewProposalId = useRef<string | null>(null);
  // Asking whether to stop a running breakdown, or to leave the review step
  const [leave, setLeave] = useState<{ kind: 'working' | 'review'; close: boolean } | null>(null);
  // Breakdown keys already created (key -> task id), so a retry after a failure continues
  const createdIds = useRef<Map<string, string>>(new Map());

  // Draft state
  const [isDraftRestored, setIsDraftRestored] = useState(false);

  // Load draft when dialog opens
  useEffect(() => {
    if (open && projectId) {
      const draft = loadDraft(projectId);
      if (draft && !isDraftEmpty(draft)) {
        setDescription(draft.description);
        setImages(draft.images);
        setMcpConnectors(draft.mcpConnectors ?? defaultConnectors);
        setPushNewBranches(draft.pushNewBranches ?? projectPushNewBranches);
        setIsDraftRestored(true);
      } else {
        // No draft - reset to clean state for new task creation
        // This ensures no stale data from previous task creation persists
        setDescription('');
        setImages([]);
        setMcpConnectors(defaultConnectors);
        setBaseBranch(PROJECT_DEFAULT_BRANCH);
        setNewBranchName('');
        setNewBranchFrom(PROJECT_DEFAULT_BRANCH);
        setUseWorktree(true);
        setPushNewBranches(projectPushNewBranches);
        setIsDraftRestored(false);
      }
    }
  }, [open, projectId, projectPushNewBranches]);


  /**
   * Get current form state as a draft
   */
  const getCurrentDraft = useCallback((): TaskCreationDraft => ({
    projectId,
    description,
    images,
    mcpConnectors,
    pushNewBranches,
    savedAt: new Date()
  }), [projectId, description, images, mcpConnectors, pushNewBranches]);

  const buildMetadata = (override: AgentOverride | undefined, forceUiWork?: boolean): TaskMetadata => {
    const metadata: TaskMetadata = { sourceType: 'manual' };
    if (images.length > 0) metadata.attachedImages = images;
    // Always include baseBranch - resolve PROJECT_DEFAULT_BRANCH to actual branch name
    // This ensures the backend always knows which branch to use for worktree creation. A new
    // branch also stores the branch it is created from (newBaseBranchFrom) and, like a chosen
    // local branch, useLocalBranch (keeps gitignored files by not switching to origin)
    Object.assign(metadata, buildBaseBranchMetadata(baseBranchChoice));
    // Pass worktree preference - false means use --direct mode
    if (!useWorktree) metadata.useWorktree = false;
    if (!pushNewBranches) metadata.pushNewBranches = false;
    metadata.mcpConnectors = mcpConnectors;
    const pinned = normalizeAgentOverride(override);
    if (pinned) metadata.agentOverride = pinned;
    if (forceUiWork !== undefined) metadata.uiWork = forceUiWork;
    return metadata;
  };

  const handleCreate = async () => {
    if (!description.trim()) {
      setError(t('tasks:form.errors.descriptionRequired'));
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const metadata = buildMetadata(agentOverride, uiWork);

      // The title is generated from the description (and refined by triage when the task starts)
      const task = await createTask(projectId, '', description.trim(), metadata);
      if (task) {
        clearDraft(projectId);
        resetForm();
        onOpenChange(false);
      } else {
        setError(t('tasks:wizard.errors.createFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:errors.unknownError'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleBreakDown = async () => {
    if (!description.trim()) {
      setError(t('tasks:form.errors.descriptionRequired'));
      return;
    }
    const requestId = `breakdown-${Date.now()}`;
    breakdownRequestId.current = requestId;
    breakdownStartedAt.current = Date.now();
    // A retry (or a result left by "Back") is replaced by the new run's own stored entry
    if (reviewProposalId.current) void window.electronAPI.dismissQueueProposal(projectId, reviewProposalId.current);
    reviewProposalId.current = null;
    setBreakdownProgress(null);
    setError(null);
    setStep('working');
    try {
      const result = await window.electronAPI.breakDownTask(
        projectId,
        requestId,
        description.trim(),
        images.map((image) => image.filename)
      );
      if (breakdownRequestId.current !== requestId) return; // cancelled, or left running in the background
      setLeave(null);
      if (result.success && result.data) {
        createdIds.current = new Map();
        reviewProposalId.current = result.data.proposalId ?? null;
        specBatch.current = result.data.batchId
          ? { id: result.data.batchId, sources: result.data.specSources ?? [], prompt: description.trim() }
          : null;
        setBreakdownItems(result.data.tasks.map((task) => ({ ...task, included: true })));
        setOpenTickets(result.data.openTickets ?? []);
        setStep('review');
      } else {
        setError(t('tasks:breakdown.failed', { error: result.error || t('common:errors.unknownError') }));
        setStep('form');
      }
    } catch (err) {
      if (breakdownRequestId.current !== requestId) return;
      setError(t('tasks:breakdown.failed', { error: err instanceof Error ? err.message : t('common:errors.unknownError') }));
      setStep('form');
    } finally {
      if (breakdownRequestId.current === requestId) breakdownRequestId.current = null;
    }
  };

  // Live progress of the running breakdown
  useEffect(() => {
    if (step !== 'working') return undefined;
    return window.electronAPI.onBreakDownProgress((requestId, progress) => {
      if (requestId === breakdownRequestId.current) setBreakdownProgress(progress);
    });
  }, [step]);

  const handleCancelBreakDown = () => {
    const requestId = breakdownRequestId.current;
    breakdownRequestId.current = null;
    if (requestId) window.electronAPI.cancelBreakDownTask(requestId);
    setStep('form');
  };

  const handleCreateBreakdown = async () => {
    const dependencies = effectiveDependencies(breakdownItems);
    const existingDependencies = effectiveExistingDependencies(breakdownItems);
    const selected = sortByDependencies(
      breakdownItems.filter((item) => item.included).map((item) => ({ ...item, dependsOn: dependencies[item.key] ?? [] }))
    );
    if (selected.length === 0) {
      setError(t('tasks:breakdown.noneSelected'));
      return;
    }
    setIsCreating(true);
    setError(null);
    let doneCount = 0;
    try {
      for (const item of selected) {
        if (createdIds.current.has(item.key)) {
          doneCount += 1;
          continue;
        }
        const metadata = buildMetadata(item.agentOverride);
        const dependsOnTaskIds = [
          ...(existingDependencies[item.key] ?? []),
          ...(dependencies[item.key] ?? []).map((key) => createdIds.current.get(key)).filter((id): id is string => !!id),
        ];
        if (dependsOnTaskIds.length > 0) metadata.dependsOnTaskIds = dependsOnTaskIds;
        if (specBatch.current) metadata.specBatch = { id: specBatch.current.id, source: specBatch.current.sources, round: 0 };
        const task = await createTask(projectId, item.title.trim(), item.description.trim() || item.title.trim(), metadata);
        if (!task) throw new Error(t('tasks:wizard.errors.createFailed'));
        createdIds.current.set(item.key, task.id);
        doneCount += 1;
      }
      if (specBatch.current) {
        // The batch gets its Spec review ticket once all these tickets are finished
        await window.electronAPI.registerSpecBatch(projectId, {
          id: specBatch.current.id,
          prompt: specBatch.current.prompt,
          sources: specBatch.current.sources,
          taskIds: Array.from(createdIds.current.values()),
        });
      }
      if (queueAfterCreate) {
        await queueTasksInOrder(projectId, selected.map((item) => createdIds.current.get(item.key)!));
      }
      if (reviewProposalId.current) void window.electronAPI.dismissQueueProposal(projectId, reviewProposalId.current);
      clearDraft(projectId);
      resetForm();
      onOpenChange(false);
    } catch (err) {
      setError(t('tasks:breakdown.createFailed', {
        done: doneCount,
        total: selected.length,
        error: err instanceof Error ? err.message : t('common:errors.unknownError'),
      }));
    } finally {
      setIsCreating(false);
    }
  };

  const resetForm = () => {
    setStep('form');
    setBreakdownItems([]);
    setOpenTickets([]);
    reviewProposalId.current = null;
    setLeave(null);
    createdIds.current = new Map();
    setDescription('');
    setImages([]);
    setMcpConnectors(defaultConnectors);
    setAgentOverride(undefined);
    setBaseBranch(PROJECT_DEFAULT_BRANCH);
    setNewBranchName('');
    setNewBranchFrom(PROJECT_DEFAULT_BRANCH);
    setUseWorktree(true);
    setPushNewBranches(projectPushNewBranches);
    setError(null);
    setIsDraftRestored(false);
  };

  // Review a stored proposal: the prompt, the tickets and their spec batch come back as they were
  useEffect(() => {
    if (!open || !initialBreakdown || initialBreakdown.projectId !== projectId) return;
    const { breakdown } = initialBreakdown;
    if (!breakdown) {
      // Retry of a failed or interrupted run: the prompt comes back in the form
      reviewProposalId.current = initialBreakdown.proposalId;
      setDescription(initialBreakdown.prompt);
      setError(null);
      setStep('form');
      onBreakdownConsumed?.();
      return;
    }
    // Open tickets as they are now: one that was merged since no longer needs waiting for
    const open_ = listOpenTickets(useTaskStore.getState().tasks);
    const openIds = new Set(open_.map((ticket) => ticket.id));
    createdIds.current = new Map();
    specBatch.current = breakdown.batchId
      ? { id: breakdown.batchId, sources: breakdown.specSources ?? [], prompt: initialBreakdown.prompt }
      : null;
    reviewProposalId.current = initialBreakdown.proposalId;
    setDescription(initialBreakdown.prompt);
    setOpenTickets(open_);
    setBreakdownItems(
      breakdown.tasks.map((task) => ({
        ...task,
        dependsOnExisting: (task.dependsOnExisting ?? []).filter((id) => openIds.has(id)),
        included: true,
      }))
    );
    setError(null);
    setStep('review');
    onBreakdownConsumed?.();
  }, [open, initialBreakdown, projectId, onBreakdownConsumed]);

  // The breakdown under review, as it can be stored again
  const currentBreakdown = (): TaskBreakdown => ({
    tasks: breakdownItems.map(({ included: _included, agentOverride: _agentOverride, ...task }) => task),
    openTickets,
    batchId: specBatch.current?.id,
    specSources: specBatch.current?.sources,
  });

  /** Close the dialog, keeping the form as a draft */
  const closeDialog = () => {
    const draft = getCurrentDraft();
    if (!isDraftEmpty(draft)) {
      saveDraft(draft);
    } else {
      clearDraft(projectId);
    }

    resetForm();
    onOpenChange(false);
  };

  /** Stop the running breakdown (what the work did so far is lost) */
  const stopBreakdown = (close: boolean) => {
    setLeave(null);
    handleCancelBreakDown();
    if (close) closeDialog();
  };

  /** Stop was asked for: a short run stops at once, a long one asks first */
  const requestStop = (close: boolean) => {
    if (Date.now() - breakdownStartedAt.current < LONG_BREAKDOWN_MS) stopBreakdown(close);
    else setLeave({ kind: 'working', close });
  };

  /** Close the dialog and let the run finish in main; its result waits in the Queue updates panel */
  const keepWorkingInBackground = () => {
    breakdownRequestId.current = null;
    setLeave(null);
    closeDialog();
  };

  /** Leave the review step: keep the proposal for later, or throw it away */
  const leaveReview = (keep: boolean) => {
    if (keep) {
      // The result is already stored; this keeps the edits made here
      void window.electronAPI.saveBreakdownProposal(
        projectId,
        specBatch.current?.prompt ?? description.trim(),
        images.map((image) => image.filename),
        currentBreakdown(),
        reviewProposalId.current ?? undefined
      );
    } else if (reviewProposalId.current) {
      void window.electronAPI.dismissQueueProposal(projectId, reviewProposalId.current);
    }
    setLeave(null);
    closeDialog();
  };

  // A running breakdown and a review under way are not closed by a stray click or Escape: only the
  // X and the buttons ask, and they ask before anything is lost
  const handleClose = () => {
    if (isCreating) return;
    if (step === 'working') {
      requestStop(true);
      return;
    }
    if (step === 'review') {
      setLeave({ kind: 'review', close: true });
      return;
    }
    closeDialog();
  };

  const handleDiscardDraft = () => {
    clearDraft(projectId);
    resetForm();
    setError(null);
  };

  // Git options, rendered as the last section of the form (the edit dialog has them too)
  const gitOptionsSection = (
    <TaskGitOptionsSection
      options={gitOptions}
      baseBranch={baseBranch}
      onBaseBranchChange={setBaseBranch}
      allowNewBranch
      newBranchName={newBranchName}
      onNewBranchNameChange={setNewBranchName}
      newBranchFrom={newBranchFrom}
      onNewBranchFromChange={setNewBranchFrom}
      pushNewBranches={pushNewBranches}
      onPushNewBranchesChange={setPushNewBranches}
      disabled={isCreating}
    />
  );

  const includedCount = breakdownItems.filter((item) => item.included).length;

  return (
    <>
    <TaskModalLayout
      lockOutside={step === 'working' || step === 'review'}
      open={open}
      onOpenChange={handleClose}
      title={step === 'review' ? t('tasks:breakdown.title') : t('tasks:wizard.createTitle')}
      description={step === 'review' ? t('tasks:breakdown.description') : t('tasks:wizard.createDescription')}
      disabled={isCreating}
      footer={
        step === 'review' ? (
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setError(null); setStep('form'); }} disabled={isCreating}>
              {t('tasks:breakdown.back')}
            </Button>
            <Button size="sm" onClick={handleCreateBreakdown} disabled={isCreating || includedCount === 0}>
              {isCreating ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t('tasks:breakdown.creating')}
                </>
              ) : (
                t('tasks:breakdown.createCount', { count: includedCount })
              )}
            </Button>
          </div>
        ) : step === 'working' ? (
          <div className="flex items-center justify-end">
            <Button variant="ghost" size="sm" onClick={() => requestStop(false)}>
              {t('tasks:breakdown.cancel')}
            </Button>
          </div>
        ) : (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* Draft restored indicator */}
            {isDraftRestored && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-(--nav-label-color)">
                  {t('tasks:wizard.draftRestored')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground hover:text-foreground"
                  onClick={handleDiscardDraft}
                >
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {t('tasks:wizard.startFresh')}
                </Button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleClose} disabled={isCreating}>
              {t('common:buttons.cancel')}
            </Button>
            <Button variant="outline" size="sm" onClick={handleBreakDown} disabled={isCreating || !description.trim() || !isBaseBranchValid}>
              {t('tasks:wizard.breakIntoTasks')}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={isCreating || !description.trim() || !isBaseBranchValid}>
              {isCreating ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t('tasks:wizard.creating')}
                </>
              ) : (
                t('tasks:wizard.createTask')
              )}
            </Button>
          </div>
        </div>
        )
      }
    >
      {step === 'working' && (
        <BreakdownWorking progress={breakdownProgress} />
      )}
      {step === 'review' && (
        <TaskBreakdownReview
          items={breakdownItems}
          openTickets={openTickets}
          onItemsChange={setBreakdownItems}
          queue={queueAfterCreate}
          onQueueChange={setQueueAfterCreate}
          disabled={isCreating}
          error={error}
        />
      )}
      {/* Main form fields (Git options are appended as an extra section) */}
      {step === 'form' && <TaskFormFields
        description={description}
        onDescriptionChange={setDescription}
        descriptionPlaceholder={t('tasks:wizard.descriptionPlaceholder')}
        images={images}
        onImagesChange={setImages}
        mcpConnectors={mcpConnectors}
        onMcpConnectorsChange={setMcpConnectors}
        agentOverride={agentOverride}
        onAgentOverrideChange={setAgentOverride}
        uiWork={uiWork}
        onUiWorkChange={setUiWork}
        disabled={isCreating}
        error={error}
        onError={setError}
        idPrefix="create"
        extraSections={gitOptionsSection}
      />}
    </TaskModalLayout>

    <AlertDialog open={leave !== null} onOpenChange={(next) => { if (!next) setLeave(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{leave?.kind === 'review' ? t('tasks:breakdown.leaveTitle') : t('tasks:breakdown.stopTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {leave?.kind === 'review' ? t('tasks:breakdown.leaveDescription') : t('tasks:breakdown.stopDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{leave?.kind === 'review' ? t('tasks:breakdown.keepReviewing') : t('tasks:breakdown.keepWaiting')}</AlertDialogCancel>
          {leave?.kind === 'review' ? (
            <>
              <AlertDialogAction className={buttonVariants({ variant: 'outline' })} onClick={() => leaveReview(false)}>
                {t('tasks:breakdown.discard')}
              </AlertDialogAction>
              <AlertDialogAction onClick={() => leaveReview(true)}>{t('tasks:breakdown.saveForLater')}</AlertDialogAction>
            </>
          ) : (
            <>
              <AlertDialogAction className={buttonVariants({ variant: 'outline' })} onClick={() => stopBreakdown(leave?.close ?? false)}>
                {t('tasks:breakdown.stopConfirm')}
              </AlertDialogAction>
              <AlertDialogAction onClick={keepWorkingInBackground}>{t('tasks:breakdown.background')}</AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
