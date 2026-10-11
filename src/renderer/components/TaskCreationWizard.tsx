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
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { SettingsRow, SettingsRows } from './settings/SettingsRow';
import { SettingsSection } from './settings/SettingsSection';
import { Combobox } from './ui/combobox';
import { TaskModalLayout } from './task-form/TaskModalLayout';
import { TaskFormFields } from './task-form/TaskFormFields';
import { createTask, saveDraft, loadDraft, clearDraft, isDraftEmpty, type TaskCreationDraft } from '../stores/task-store';
import { useProjectStore } from '../stores/project-store';
import { buildBranchOptions } from '../lib/branch-utils';
import type { TaskMetadata, ImageAttachment } from '../../shared/types';
import { useSettingsStore } from '../stores/settings-store';
import { useProjectBranches } from '../hooks/useProjectBranches';
import { getDefaultMcpConnectorIds } from '../../shared/utils/mcp-connectors';

interface TaskCreationWizardProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Special value for "use project default" branch
const PROJECT_DEFAULT_BRANCH = '__project_default__';

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

  // Get project path from project store
  const projects = useProjectStore((state) => state.projects);
  const projectPath = useMemo(() => {
    const project = projects.find((p) => p.id === projectId);
    return project?.path ?? null;
  }, [projects, projectId]);
  // Saved branch list shared with the other branch pickers (no git calls when the dialog opens);
  // the default is the project settings' branch, otherwise the repository's default
  const { branches, detectedBranch, isLoading: isLoadingBranches } = useProjectBranches(projectPath);
  const projectDefaultBranch = useMemo(() => {
    const project = projects.find((p) => p.id === projectId);
    return project?.settings?.mainBranch || detectedBranch;
  }, [projects, projectId, detectedBranch]);
  const projectPushNewBranches = useMemo(() => {
    const project = projects.find((p) => p.id === projectId);
    return project?.settings?.pushNewBranches !== false;
  }, [projects, projectId]);

  // Build branch options using shared utility - groups by local/remote with type indicators
  const branchOptions = useMemo(() => {
    const options = buildBranchOptions(branches, {
      t,
      includeProjectDefault: {
        value: PROJECT_DEFAULT_BRANCH,
        branchName: projectDefaultBranch,
        labelKey: projectDefaultBranch
          ? 'tasks:wizard.gitOptions.useProjectDefaultWithBranch'
          : 'tasks:wizard.gitOptions.useProjectDefault',
      },
    });
    // Show the branch type ("Local" / "Remote") as plain muted text instead of a colored badge
    return options.map((option) => {
      if (!option.badge) return option;
      const branchName = option.value === PROJECT_DEFAULT_BRANCH ? projectDefaultBranch : option.value;
      const branchType = branches.find((b) => b.name === branchName)?.type;
      if (!branchType) return option;
      return {
        ...option,
        badge: (
          <span className="text-xs text-(--nav-label-color)">
            {t(branchType === 'local' ? 'common:git.branchType.local' : 'common:git.branchType.remote')}
          </span>
        ),
      };
    });
  }, [branches, projectDefaultBranch, t]);

  // Determine if the selected branch is local (for useLocalBranch flag)
  const isSelectedBranchLocal = useMemo(() => {
    if (baseBranch === PROJECT_DEFAULT_BRANCH) return false;
    const selectedGitBranchDetail = branches.find((b) => b.name === baseBranch);
    return selectedGitBranchDetail?.type === 'local';
  }, [baseBranch, branches]);

  // Images
  const [images, setImages] = useState<ImageAttachment[]>([]);

  // MCP connectors start from the Connectors defaults; changes stay with this task
  const defaultConnectors = useMemo(() => getDefaultMcpConnectorIds(settings.mcpConnectors), [settings.mcpConnectors]);
  const [mcpConnectors, setMcpConnectors] = useState<string[]>(defaultConnectors);

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

  const handleCreate = async () => {
    if (!description.trim()) {
      setError(t('tasks:form.errors.descriptionRequired'));
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
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

  const resetForm = () => {
    setDescription('');
    setImages([]);
    setMcpConnectors(defaultConnectors);
    setBaseBranch(PROJECT_DEFAULT_BRANCH);
    setUseWorktree(true);
    setPushNewBranches(projectPushNewBranches);
    setError(null);
    setIsDraftRestored(false);
  };

  const handleClose = () => {
    if (isCreating) return;

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

  // Git options - unique to creation; rendered as the last section of the form
  const gitOptionsSection = (
    <SettingsSection title={t('tasks:wizard.gitOptions.title')}>
      <SettingsRows>
        <SettingsRow
          label={t('tasks:wizard.gitOptions.baseBranchLabel')}
          description={t('tasks:wizard.gitOptions.helpText')}
          htmlFor="base-branch"
        >
          <Combobox
            id="base-branch"
            value={baseBranch}
            onValueChange={setBaseBranch}
            options={branchOptions}
            placeholder={projectDefaultBranch
              ? t('tasks:wizard.gitOptions.useProjectDefaultWithBranch', { branch: projectDefaultBranch })
              : t('tasks:wizard.gitOptions.useProjectDefault')
            }
            searchPlaceholder={t('tasks:wizard.gitOptions.searchBranches')}
            emptyMessage={t('tasks:wizard.gitOptions.noBranchesFound')}
            disabled={isCreating || isLoadingBranches}
            className="h-8 w-auto max-w-[18rem] gap-1.5 border-transparent bg-transparent px-2 hover:bg-nav-hover focus:border-transparent focus:ring-0 focus-visible:shadow-(--shadow-focus) data-[state=open]:bg-nav-hover"
          />
        </SettingsRow>
        <SettingsRow
          label={t('tasks:wizard.gitOptions.pushNewBranchesLabel')}
          description={t('tasks:wizard.gitOptions.pushNewBranchesDescription')}
          htmlFor="push-new-branches"
        >
          <Switch
            id="push-new-branches"
            checked={pushNewBranches}
            onCheckedChange={setPushNewBranches}
            disabled={isCreating}
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );

  return (
    <TaskModalLayout
      open={open}
      onOpenChange={handleClose}
      title={t('tasks:wizard.createTitle')}
      description={t('tasks:wizard.createDescription')}
      disabled={isCreating}
      footer={
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
      }
    >
      {/* Main form fields (Git options are appended as an extra section) */}
      <TaskFormFields
        description={description}
        onDescriptionChange={setDescription}
        descriptionPlaceholder={t('tasks:wizard.descriptionPlaceholder')}
        images={images}
        onImagesChange={setImages}
        mcpConnectors={mcpConnectors}
        onMcpConnectorsChange={setMcpConnectors}
        disabled={isCreating}
        error={error}
        onError={setError}
        idPrefix="create"
        extraSections={gitOptionsSection}
      />
    </TaskModalLayout>
  );
}
