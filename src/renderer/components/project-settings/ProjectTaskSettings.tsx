import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows, SegmentedControl } from '../settings/SettingsRow';
import { DEFAULT_AUTONOMOUS_BRANCH, resolveAutonomousConfig } from '../../../shared/utils/autonomous';
import { resolveSelfSplit } from '../../../shared/utils/task-split';
import { useClaudeProfileStore } from '../../stores/claude-profile-store';
import { useIsOmpBackend } from '../../hooks/useIsOmpBackend';
import type { ProjectSettings as ProjectSettingsType } from '../../../shared/types';

interface ProjectTaskSettingsProps {
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
}

/**
 * Project page "Tasks" section: the Claude account the project's tasks and chats run on, and the
 * budget per task. Saved in the project's `.workbench/settings.json`.
 */
export function ProjectTaskSettings({ settings, setSettings }: ProjectTaskSettingsProps) {
  const { t } = useTranslation('settings');
  const isOmp = useIsOmpBackend();
  const profiles = useClaudeProfileStore((state) => state.profiles);
  const activeProfileId = useClaudeProfileStore((state) => state.activeProfileId);

  // Only the configured accounts are listed; without a choice (or after the chosen account was
  // removed) the project uses, and shows, the account in use
  const isAccount = (id: string | undefined) => !!id && profiles.some((profile) => profile.id === id);
  const accountValue = isAccount(settings.claudeProfileId)
    ? settings.claudeProfileId
    : isAccount(activeProfileId) ? activeProfileId : undefined;

  // The budget is typed as text so partial values ("1.") survive; saved when it parses
  const [budgetDraft, setBudgetDraft] = useState(settings.maxBudgetUsd?.toString() ?? '');
  useEffect(() => {
    setBudgetDraft((draft) => {
      const parsed = draft.trim() === '' ? undefined : Number(draft);
      return parsed === settings.maxBudgetUsd ? draft : settings.maxBudgetUsd?.toString() ?? '';
    });
  }, [settings.maxBudgetUsd]);

  // The integration branch name is typed as text; an invalid name falls back to the default when used
  const autonomous = resolveAutonomousConfig(settings);
  const [branchDraft, setBranchDraft] = useState(settings.autonomousBranch ?? '');
  useEffect(() => {
    setBranchDraft((draft) => ((settings.autonomousBranch ?? '') === draft.trim() ? draft : settings.autonomousBranch ?? ''));
  }, [settings.autonomousBranch]);

  const handleBudgetChange = (value: string) => {
    setBudgetDraft(value);
    if (value.trim() === '') {
      setSettings({ ...settings, maxBudgetUsd: undefined });
      return;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) setSettings({ ...settings, maxBudgetUsd: parsed });
  };

  return (
    <SettingsSection title={t('projectPages.tasks.title')}>
      <SettingsRows>
        {/* Account and budget are Claude Code's (its account, --max-budget-usd); OMP has neither */}
        {!isOmp && (
          <SettingsRow
            label={t('projectPages.tasks.account')}
            description={t('projectPages.tasks.accountDescription')}
            htmlFor="project-claude-account"
          >
            <Select
              value={accountValue}
              onValueChange={(value) => setSettings({ ...settings, claudeProfileId: value })}
              disabled={profiles.length === 0}
            >
              <SelectTrigger id="project-claude-account" className="h-8">
                <SelectValue placeholder={t('projectPages.tasks.noAccounts')} />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        )}

        {!isOmp && (
          <SettingsRow
            label={t('projectPages.tasks.budget')}
            description={t('projectPages.tasks.budgetDescription')}
            htmlFor="project-task-budget"
          >
            <Input
              id="project-task-budget"
              type="number"
              inputMode="decimal"
              min={0}
              step={0.5}
              className="w-24"
              placeholder={t('projectPages.tasks.budgetPlaceholder')}
              value={budgetDraft}
              onChange={(e) => handleBudgetChange(e.target.value)}
            />
          </SettingsRow>
        )}

        <SettingsRow
          label={t('projectPages.tasks.groomQueue')}
          description={t('projectPages.tasks.groomQueueDescription')}
        >
          <Switch
            checked={settings.groomQueueAfterMerge !== false}
            onCheckedChange={(checked) => setSettings({ ...settings, groomQueueAfterMerge: checked })}
            aria-label={t('projectPages.tasks.groomQueue')}
          />
        </SettingsRow>

        <SettingsRow
          label={t('projectPages.tasks.followUpTickets')}
          description={t('projectPages.tasks.followUpTicketsDescription')}
        >
          <Switch
            checked={settings.followUpTickets !== false}
            onCheckedChange={(checked) => setSettings({ ...settings, followUpTickets: checked })}
            aria-label={t('projectPages.tasks.followUpTickets')}
          />
        </SettingsRow>

        <SettingsRow
          label={t('projectPages.tasks.specReview')}
          description={t('projectPages.tasks.specReviewDescription')}
        >
          <Switch
            checked={settings.specReview !== false}
            onCheckedChange={(checked) => setSettings({ ...settings, specReview: checked })}
            aria-label={t('projectPages.tasks.specReview')}
          />
        </SettingsRow>

        <SettingsRow
          label={t('projectPages.tasks.selfSplit')}
          description={t('projectPages.tasks.selfSplitDescription')}
        >
          <SegmentedControl
            value={resolveSelfSplit(settings)}
            options={[
              { value: 'off', label: t('projectPages.tasks.selfSplitOff') },
              { value: 'propose', label: t('projectPages.tasks.selfSplitPropose') },
              { value: 'auto', label: t('projectPages.tasks.selfSplitAuto') },
            ]}
            onValueChange={(value) => setSettings({ ...settings, selfSplit: value })}
            ariaLabel={t('projectPages.tasks.selfSplit')}
          />
        </SettingsRow>

        <SettingsRow
          label={t('projectPages.tasks.autonomous')}
          description={t('projectPages.tasks.autonomousDescription')}
        >
          <Switch
            checked={autonomous.enabled}
            onCheckedChange={(checked) => setSettings({ ...settings, autonomous: checked })}
            aria-label={t('projectPages.tasks.autonomous')}
          />
        </SettingsRow>

        {autonomous.enabled && (
          <>
            <SettingsRow
              label={t('projectPages.tasks.autonomousTarget')}
              description={t(autonomous.target === 'integration'
                ? 'projectPages.tasks.autonomousTargetIntegrationDescription'
                : 'projectPages.tasks.autonomousTargetMainDescription')}
            >
              <SegmentedControl
                value={autonomous.target}
                options={[
                  { value: 'integration', label: t('projectPages.tasks.autonomousTargetIntegration') },
                  { value: 'main', label: t('projectPages.tasks.autonomousTargetMain') },
                ]}
                onValueChange={(value) => setSettings({ ...settings, autonomousTarget: value })}
                ariaLabel={t('projectPages.tasks.autonomousTarget')}
              />
            </SettingsRow>

            {autonomous.target === 'integration' && (
              <SettingsRow
                label={t('projectPages.tasks.autonomousBranch')}
                description={t('projectPages.tasks.autonomousBranchDescription')}
                htmlFor="project-autonomous-branch"
              >
                <Input
                  id="project-autonomous-branch"
                  className="w-48"
                  placeholder={DEFAULT_AUTONOMOUS_BRANCH}
                  value={branchDraft}
                  onChange={(e) => {
                    setBranchDraft(e.target.value);
                    setSettings({ ...settings, autonomousBranch: e.target.value.trim() || undefined });
                  }}
                />
              </SettingsRow>
            )}

            <SettingsRow
              label={t('projectPages.tasks.autonomousPush')}
              description={t('projectPages.tasks.autonomousPushDescription')}
            >
              <Switch
                checked={autonomous.push}
                onCheckedChange={(checked) => setSettings({ ...settings, autonomousPush: checked })}
                aria-label={t('projectPages.tasks.autonomousPush')}
              />
            </SettingsRow>
          </>
        )}
      </SettingsRows>
    </SettingsSection>
  );
}
