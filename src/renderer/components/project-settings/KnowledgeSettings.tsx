import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { useGraphifyVersion } from '../../hooks/useGraphifyVersion';
import type { ProjectSettings as ProjectSettingsType } from '../../../shared/types';

interface KnowledgeSettingsProps {
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
}

/**
 * Project page "Knowledge" section: what agents get to know about the project (the Graphify
 * knowledge graph and CLAUDE.md). Saved in the project's `.auto-claude/settings.json`.
 */
export function KnowledgeSettings({ settings, setSettings }: KnowledgeSettingsProps) {
  const { t } = useTranslation('settings');
  const graphifyInstalled = !!useGraphifyVersion().info?.installed;

  return (
    <SettingsSection title={t('projectSections.knowledge.title')}>
      <SettingsRows>
        {/* The switch needs the Graphify CLI (Settings > Updates) */}
        <SettingsRow
          label={t('projectSections.general.useGraphify')}
          description={
            graphifyInstalled
              ? t('projectSections.general.useGraphifyDescription')
              : t('projectSections.general.useGraphifyNotInstalled')
          }
        >
          <Switch
            checked={graphifyInstalled && !!settings.useGraphify}
            onCheckedChange={(checked) => setSettings({ ...settings, useGraphify: checked })}
            disabled={!graphifyInstalled}
            aria-label={t('projectSections.general.useGraphify')}
          />
        </SettingsRow>
        <SettingsRow
          label={t('projectSections.general.useClaudeMd')}
          description={t('projectSections.general.useClaudeMdDescription')}
        >
          <Switch
            checked={settings.useClaudeMd ?? true}
            onCheckedChange={(checked) => setSettings({ ...settings, useClaudeMd: checked })}
            aria-label={t('projectSections.general.useClaudeMd')}
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
