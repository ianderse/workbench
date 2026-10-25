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
import { Button } from './ui/button';
import { TaskModalLayout } from './task-form/TaskModalLayout';
import { TaskFormFields } from './task-form/TaskFormFields';
import { PROJECT_DEFAULT_BRANCH, TaskGitOptionsSection, useTaskGitOptions } from './task-form/TaskGitOptions';
import { createTask, queueTasksInOrder, saveDraft, loadDraft, clearDraft, isDraftEmpty, type TaskCreationDraft } from '../stores/task-store';
import type { TaskMetadata, ImageAttachment, AgentOverride } from '../../shared/types';
import { normalizeAgentOverride } from '../../shared/utils/agent-override';
import { useSettingsStore } from '../stores/settings-store';
import { TaskBreakdownReview, effectiveDependencies, effectiveExistingDependencies, type BreakdownItem } from './task-form/TaskBreakdownReview';
import type { OpenTicketRef } from '../../shared/types/task-breakdown';
import { sortByDependencies } from '../../shared/utils/task-breakdown-order';
import { getDefaultMcpConnectorIds } from '../../shared/utils/mcp-connectors';

interface TaskCreationWizardProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}


export function TaskCreationWizard({
  projectId,
  open,
  onOpenChange
}: TaskCreationWizardProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { settings } = useSettingsStore();

  // Form state
  const [description, setDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Git options state - using structured GitBranchDetail for type indicators
  const [baseBranch, setBaseBranch] = useState<string>(PROJECT_DEFAULT_BRANCH);
  // Worktree isolation - default to true for safety
  const [useWorktree, setUseWorktree] = useState(true);
  const [pushNewBranches, setPushNewBranches] = useState(true);

  // The project's branches (the shared list, no git calls when the dialog opens) and its own
  // git defaults, shared with the edit dialog
  const gitOptions = useTaskGitOptions(projectId);
  const { projectDefaultBranch, projectPushNewBranches } = gitOptions;

  // Determine if the selected branch is local (for useLocalBranch flag)
  const isSelectedBranchLocal = baseBranch !== PROJECT_DEFAULT_BRANCH && gitOptions.isLocalBranch(baseBranch);

  // Images
  const [images, setImages] = useState<ImageAttachment[]>([]);

  // MCP connectors start from the Connectors defaults; changes stay with this task
  const defaultConnectors = useMemo(() => getDefaultMcpConnectorIds(settings.mcpConnectors), [settings.mcpConnectors]);
  const [mcpConnectors, setMcpConnectors] = useState<string[]>(defaultConnectors);

  // Model and effort pinned on the task (unset = triage decides)
  const [agentOverride, setAgentOverride] = useState<AgentOverride | undefined>(undefined);

  // "Break into tasks": 'form' -> 'working' (model call) -> 'review' -> creating
  const [step, setStep] = useState<'form' | 'working' | 'review'>('form');
  const [breakdownItems, setBreakdownItems] = useState<BreakdownItem[]>([]);
  const [openTickets, setOpenTickets] = useState<OpenTicketRef[]>([]);
  const [queueAfterCreate, setQueueAfterCreate] = useState(true);
  const breakdownRequestId = useRef<string | null>(null);
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

  const buildMetadata = (override: AgentOverride | undefined): TaskMetadata => {
    const metadata: TaskMetadata = { sourceType: 'manual' };
    if (images.length > 0) metadata.attachedImages = images;
    // Always include baseBranch - resolve PROJECT_DEFAULT_BRANCH to actual branch name
    // This ensures the backend always knows which branch to use for worktree creation
    if (baseBranch === PROJECT_DEFAULT_BRANCH) {
      // Use the resolved project default branch
      if (projectDefaultBranch) metadata.baseBranch = projectDefaultBranch;
    } else if (baseBranch) {
      metadata.baseBranch = baseBranch;
    }
    // Pass worktree preference - false means use --direct mode
    if (!useWorktree) metadata.useWorktree = false;
    // Set useLocalBranch when user explicitly selects a local branch
    // This preserves gitignored files (.env, configs) by not switching to origin
    if (isSelectedBranchLocal) metadata.useLocalBranch = true;
    if (!pushNewBranches) metadata.pushNewBranches = false;
    metadata.mcpConnectors = mcpConnectors;
    const pinned = normalizeAgentOverride(override);
    if (pinned) metadata.agentOverride = pinned;
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
      const metadata = buildMetadata(agentOverride);

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
    setError(null);
    setStep('working');
    try {
      const result = await window.electronAPI.breakDownTask(
        projectId,
        requestId,
        description.trim(),
        images.map((image) => image.filename)
      );
      if (breakdownRequestId.current !== requestId) return; // cancelled
      if (result.success && result.data) {
        createdIds.current = new Map();
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
        const task = await createTask(projectId, item.title.trim(), item.description.trim() || item.title.trim(), metadata);
        if (!task) throw new Error(t('tasks:wizard.errors.createFailed'));
        createdIds.current.set(item.key, task.id);
        doneCount += 1;
      }
      if (queueAfterCreate) {
        await queueTasksInOrder(projectId, selected.map((item) => createdIds.current.get(item.key)!));
      }
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
    createdIds.current = new Map();
    setDescription('');
    setImages([]);
    setMcpConnectors(defaultConnectors);
    setAgentOverride(undefined);
    setBaseBranch(PROJECT_DEFAULT_BRANCH);
    setUseWorktree(true);
    setPushNewBranches(projectPushNewBranches);
    setError(null);
    setIsDraftRestored(false);
  };

  const handleClose = () => {
    if (isCreating) return;
    if (step === 'working') handleCancelBreakDown();

    const draft = getCurrentDraft();
    if (!isDraftEmpty(draft)) {
      saveDraft(draft);
    } else {
      clearDraft(projectId);
    }

    resetForm();
    onOpenChange(false);
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
      pushNewBranches={pushNewBranches}
      onPushNewBranchesChange={setPushNewBranches}
      disabled={isCreating}
    />
  );

  const includedCount = breakdownItems.filter((item) => item.included).length;

  return (
    <TaskModalLayout
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
            <Button variant="ghost" size="sm" onClick={handleCancelBreakDown}>
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
            <Button variant="outline" size="sm" onClick={handleBreakDown} disabled={isCreating || !description.trim()}>
              {t('tasks:wizard.breakIntoTasks')}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={isCreating || !description.trim()}>
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
        <div className="flex flex-col items-center gap-2 py-12 text-center" role="status">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-foreground">{t('tasks:breakdown.working')}</p>
          <p className="text-xs text-(--nav-label-color)">{t('tasks:breakdown.workingHint')}</p>
        </div>
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
        disabled={isCreating}
        error={error}
        onError={setError}
        idPrefix="create"
        extraSections={gitOptionsSection}
      />}
    </TaskModalLayout>
  );
}
