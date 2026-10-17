import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { cn } from '../../lib/utils';
import { formatDateTime } from '../../../shared/utils/format-date-time';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { useGraphifyVersion } from '../../hooks/useGraphifyVersion';
import { useMemoryGraphStore } from '../../stores/memory-graph-store';
import { useSelfLearningStore } from '../../stores/self-learning-store';
import { updateProjectSettings } from '../../stores/project-store';
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
  const selfLearning = settings.selfLearning ?? false;
  const memoryIndex = useSelfLearningStore((state) => state.index[projectId] ?? null);
  const isIndexing = useSelfLearningStore((state) => !!state.building[projectId]);
  const indexError = useSelfLearningStore((state) => state.buildError[projectId] ?? null);
  const refreshMemoryIndex = useSelfLearningStore((state) => state.refresh);
  const buildMemoryIndex = useSelfLearningStore((state) => state.build);
  const buildMemoryIndexIfEmpty = useSelfLearningStore((state) => state.buildIfEmpty);

  // Stored stats, read once per project (a small local file); a build is what changes them
  useEffect(() => {
    if (selfLearning) void refreshMemoryIndex(projectId);
  }, [projectId, selfLearning, refreshMemoryIndex]);

  /**
   * Switching self-learning on relocates the project's Claude Code memory and then, for a project
   * with no memories yet, reads its past sessions so it starts out knowing what the user already
   * said. The setting is saved here rather than left to the dialog's debounce, so the relocation is
   * in place before the scan writes anything.
   */
  const toggleSelfLearning = async (enabled: boolean) => {
    const next = { ...settings, selfLearning: enabled };
    setSettings(next);
    await updateProjectSettings(projectId, next);
    if (enabled) await buildMemoryIndexIfEmpty(projectId);
  };

  const memoryIndexDescription = !selfLearning
    ? t('projectSections.general.memoryIndexNotEnabled')
    : isIndexing
      ? t('projectSections.general.memoryIndexBuilding')
      : memoryIndex
        ? t('projectSections.general.memoryIndexDescription', {
            memories: memoryIndex.memories,
            sessions: memoryIndex.sessionsScanned,
            time: formatDateTime(memoryIndex.builtAt),
          })
        : t('projectSections.general.noMemoryIndex');

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
            checked={selfLearning}
            onCheckedChange={(checked) => void toggleSelfLearning(checked)}
            disabled={isIndexing}
            aria-label={t('projectSections.general.selfLearning')}
          />
        </SettingsRow>
        {/* Builds the project's first memories from the sessions it already had, and rebuilds to
            fold in sessions that happened while the switch was off */}
        <SettingsRow label={t('projectSections.general.memoryIndex')} description={memoryIndexDescription}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void buildMemoryIndex(projectId)}
            disabled={!selfLearning || isIndexing}
            className="gap-2"
          >
            <RefreshCw className={cn('h-4 w-4', isIndexing && 'animate-spin')} strokeWidth={1.75} />
            {memoryIndex
              ? t('projectSections.general.rebuildMemoryIndex')
              : t('projectSections.general.buildMemoryIndex')}
          </Button>
        </SettingsRow>
        {indexError !== null && (
          <SettingsRow
            label={t('projectSections.general.memoryIndexFailed')}
            description={indexError || t('projectSections.general.memoryIndexFailedUnknown')}
          />
        )}
      </SettingsRows>
    </SettingsSection>
  );
}
