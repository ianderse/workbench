/**
 * TaskGitOptions - the Git section of the task create and edit dialogs
 *
 * The branch the task's worktree starts from and whether that branch is pushed. Both are kept in
 * the task's metadata, so a task created with a branch that has since been deleted or renamed can
 * be pointed at one that exists (the picker shows the stored branch even when it is gone).
 *
 * `useTaskGitOptions` reads the project's branches once (the shared list, no git fetch) and the
 * project's own defaults, which the dialogs also need to build the task's metadata.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { SettingsSection } from '../settings/SettingsSection';
import { buildBranchOptions } from '../../lib/branch-utils';
import { useProjectBranches } from '../../hooks/useProjectBranches';
import { useProjectStore } from '../../stores/project-store';

/** Base branch value standing for "whatever the project's default branch is" */
export const PROJECT_DEFAULT_BRANCH = '__project_default__';

export interface TaskGitOptions {
  /** Branch options for the picker, including the project default and the stored branch */
  branchOptions: ComboboxOption[];
  /** The project's default branch (its setting, else the one detected in the repo) */
  projectDefaultBranch: string;
  /** Whether the project pushes new task branches by default */
  projectPushNewBranches: boolean;
  isLoadingBranches: boolean;
  /** Whether a branch name is a local branch of the project */
  isLocalBranch: (branch: string) => boolean;
  /**
   * Whether the project no longer has this branch, the check behind the "Not in the project"
   * label. A branch list that has not arrived yet claims nothing.
   */
  isMissingBranch: (branch: string | undefined) => boolean;
}

/**
 * The project's branch options and git defaults for a task dialog.
 * `storedBranch` is the task's own base branch, listed even when the project no longer has it.
 */
export function useTaskGitOptions(projectId: string, storedBranch?: string): TaskGitOptions {
  const { t } = useTranslation(['tasks', 'common']);
  const projects = useProjectStore((state) => state.projects);
  const project = useMemo(() => projects.find((candidate) => candidate.id === projectId), [projects, projectId]);
  const { branches, detectedBranch, isLoading } = useProjectBranches(project?.path);

  const projectDefaultBranch = project?.settings?.mainBranch || detectedBranch;
  const projectPushNewBranches = project?.settings?.pushNewBranches !== false;

  // A branch the project does not have is the one the picker labels "Not in the project". The
  // branch list is empty while it loads, and an empty list says nothing about any branch
  const isMissingBranch = (branch: string | undefined): boolean =>
    !!branch &&
    branch !== PROJECT_DEFAULT_BRANCH &&
    branches.length > 0 &&
    !branches.some((candidate) => candidate.name === branch);

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
    const typed = options.map((option) => {
      if (!option.badge) return option;
      const branchName = option.value === PROJECT_DEFAULT_BRANCH ? projectDefaultBranch : option.value;
      const branchType = branches.find((branch) => branch.name === branchName)?.type;
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
    // A task keeps the branch it was created with; when the project no longer has it, name it
    // in the picker instead of leaving the row looking like the project default
    if (!storedBranch || typed.some((option) => option.value === storedBranch)) return typed;
    return [
      ...typed,
      {
        value: storedBranch,
        label: storedBranch,
        badge: <span className="text-xs text-warning">{t('common:git.branchType.missing')}</span>,
      },
    ];
  }, [branches, projectDefaultBranch, storedBranch, t]);

  return {
    branchOptions,
    projectDefaultBranch,
    projectPushNewBranches,
    isLoadingBranches: isLoading,
    isLocalBranch: (branch: string) => branches.find((candidate) => candidate.name === branch)?.type === 'local',
    isMissingBranch,
  };
}

interface TaskGitOptionsProps {
  options: TaskGitOptions;
  /** The selected base branch, or PROJECT_DEFAULT_BRANCH */
  baseBranch: string;
  onBaseBranchChange: (value: string) => void;
  pushNewBranches: boolean;
  onPushNewBranchesChange: (value: boolean) => void;
  disabled?: boolean;
  /** Keeps the field ids apart when both dialogs are mounted */
  idPrefix?: string;
}

export function TaskGitOptionsSection({
  options,
  baseBranch,
  onBaseBranchChange,
  pushNewBranches,
  onPushNewBranchesChange,
  disabled = false,
  idPrefix = '',
}: TaskGitOptionsProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const prefix = idPrefix ? `${idPrefix}-` : '';
  const { branchOptions, projectDefaultBranch, isLoadingBranches } = options;

  return (
    <SettingsSection title={t('tasks:wizard.gitOptions.title')}>
      <SettingsRows>
        <SettingsRow
          label={t('tasks:wizard.gitOptions.baseBranchLabel')}
          description={t('tasks:wizard.gitOptions.helpText')}
          htmlFor={`${prefix}base-branch`}
        >
          <Combobox
            id={`${prefix}base-branch`}
            value={baseBranch}
            onValueChange={onBaseBranchChange}
            options={branchOptions}
            placeholder={projectDefaultBranch
              ? t('tasks:wizard.gitOptions.useProjectDefaultWithBranch', { branch: projectDefaultBranch })
              : t('tasks:wizard.gitOptions.useProjectDefault')
            }
            searchPlaceholder={t('tasks:wizard.gitOptions.searchBranches')}
            emptyMessage={t('tasks:wizard.gitOptions.noBranchesFound')}
            disabled={disabled || isLoadingBranches}
            className="h-8 w-auto max-w-[18rem] gap-1.5 border-transparent bg-transparent px-2 hover:bg-nav-hover focus:border-transparent focus:ring-0 focus-visible:shadow-(--shadow-focus) data-[state=open]:bg-nav-hover"
          />
        </SettingsRow>
        <SettingsRow
          label={t('tasks:wizard.gitOptions.pushNewBranchesLabel')}
          description={t('tasks:wizard.gitOptions.pushNewBranchesDescription')}
          htmlFor={`${prefix}push-new-branches`}
        >
          <Switch
            id={`${prefix}push-new-branches`}
            checked={pushNewBranches}
            onCheckedChange={onPushNewBranchesChange}
            disabled={disabled}
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
