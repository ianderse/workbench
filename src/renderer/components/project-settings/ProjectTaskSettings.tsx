import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { useClaudeProfileStore } from '../../stores/claude-profile-store';
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
      </SettingsRows>
    </SettingsSection>
  );
}
