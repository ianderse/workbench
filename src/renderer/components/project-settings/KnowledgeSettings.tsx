import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { useGraphifyVersion } from '../../hooks/useGraphifyVersion';
import { useMemoryGraphStore } from '../../stores/memory-graph-store';
import type { ProjectSettings as ProjectSettingsType } from '../../../shared/types';

interface KnowledgeSettingsProps {
  projectId: string;
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
}

/**
 * Project page "Knowledge" section: what agents get to know about the project (the Graphify
 * knowledge graph and CLAUDE.md). Use Graphify is on while the project's `.workbench/knowledge`
 * folder exists (switching it off removes the folder); CLAUDE.md is saved in `.workbench/settings.json`.
 */
export function KnowledgeSettings({ projectId, settings, setSettings }: KnowledgeSettingsProps) {
  const { t } = useTranslation('settings');
  const graphifyInstalled = !!useGraphifyVersion().info?.installed;
  const graphifyEnabled = useMemoryGraphStore((state) => state.enabled[projectId]);
  const refreshGraphify = useMemoryGraphStore((state) => state.refresh);
  const setGraphifyEnabled = useMemoryGraphStore((state) => state.setEnabled);
  const isBuilding = useMemoryGraphStore((state) => !!state.building[projectId]);

  // The sidebar checks it when the project is selected; check once if it hasn't yet
  useEffect(() => {
    if (graphifyEnabled === undefined) void refreshGraphify(projectId);
  }, [graphifyEnabled, projectId, refreshGraphify]);

  return (
    <SettingsSection title={t('projectSections.knowledge.title')}>
      <SettingsRows>
        {/* The switch needs the Graphify CLI (Settings > Updates); switching it on builds the graph
            (Knowledge index), and it waits while a build runs */}
        <SettingsRow
          label={t('projectSections.general.useGraphify')}
          description={
            graphifyInstalled
              ? t('projectSections.general.useGraphifyDescription')
              : t('projectSections.general.useGraphifyNotInstalled')
          }
        >
          <Switch
            checked={graphifyInstalled && !!graphifyEnabled}
            onCheckedChange={(checked) => void setGraphifyEnabled(projectId, checked)}
            disabled={!graphifyInstalled || isBuilding}
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
        {/* Switching this on points Claude Code's own memory at .workbench/learning and tells
            sessions to save what they learn; switching it off leaves every note in place */}
        <SettingsRow
          label={t('projectSections.general.selfLearning')}
          description={t('projectSections.general.selfLearningDescription')}
        >
          <Switch
            checked={settings.selfLearning ?? false}
            onCheckedChange={(checked) => setSettings({ ...settings, selfLearning: checked })}
            aria-label={t('projectSections.general.selfLearning')}
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
