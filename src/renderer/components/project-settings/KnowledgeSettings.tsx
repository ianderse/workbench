import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { useGraphifyVersion } from '../../hooks/useGraphifyVersion';
import { useMemoryGraphStore } from '../../stores/memory-graph-store';
import { useSelfImproveStore } from '../../stores/self-improve-store';
import { useProjectIndexStore } from '../../stores/project-index-store';
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
  // Use CLAUDE.md stands for a file the sessions can read, so it follows the project's CLAUDE.md:
  // undefined until checked, null when the project has none. The Project index row (Project
  // section) writes the same file, so the switch waits for a build started there too
  const projectIndex = useProjectIndexStore((state) => state.index[projectId]);
  const isWritingClaudeMd = useProjectIndexStore((state) => !!state.building[projectId]);
  const refreshProjectIndex = useProjectIndexStore((state) => state.refresh);
  const writeProjectIndexIfMissing = useProjectIndexStore((state) => state.buildIfMissing);
  const selfImprove = settings.selfImprove ?? false;
  // The Memory index row (Project section) runs the same build, so the switch waits for it too
  const isIndexing = useSelfImproveStore((state) => !!state.building[projectId]);
  const buildMemoryIndexIfEmpty = useSelfImproveStore((state) => state.buildIfEmpty);

  /**
   * Switching Use CLAUDE.md on for a project that has none writes one with `/init`, so the switch
   * only ever stands for a file that is there; the switch waits for that run. Switching it off
   * stops sessions reading the file and leaves it where it is, to be deleted by hand or not at all.
   */
  const toggleClaudeMd = async (enabled: boolean) => {
    const next = { ...settings, useClaudeMd: enabled };
    setSettings(next);
    if (!(await updateProjectSettings(projectId, next))) {
      setSettings(settings);
      return;
    }
    if (enabled) await writeProjectIndexIfMissing(projectId);
  };

  /**
   * Switching self-improve on relocates the project's Claude Code memory and then, for a project
   * with no memories yet, reads its past sessions so it starts out knowing what the user already
   * said. The setting is saved here rather than left to the dialog's debounce, so the relocation is
   * in place before the scan writes anything.
   */
  const toggleSelfImprove = async (enabled: boolean) => {
    const next = { ...settings, selfImprove: enabled };
    setSettings(next);
    if (!(await updateProjectSettings(projectId, next))) {
      // The relocation was refused, so the memory would not be read where it is written: show the
      // switch as it really is rather than scanning past sessions into a store nothing points at
      setSettings(settings);
      return;
    }
    if (enabled) await buildMemoryIndexIfEmpty(projectId);
  };

  // The sidebar checks it when the project is selected; check once if it hasn't yet
  useEffect(() => {
    if (graphifyEnabled === undefined) void refreshGraphify(projectId);
  }, [graphifyEnabled, projectId, refreshGraphify]);

  // Nothing else reads the project's CLAUDE.md, so check for it once (a small local read)
  useEffect(() => {
    if (projectIndex === undefined) void refreshProjectIndex(projectId);
  }, [projectIndex, projectId, refreshProjectIndex]);

  return (
    <SettingsSection title={t('projectSections.knowledge.title')}>
      <SettingsRows>
        {/* On only while the project has a CLAUDE.md: switching it on for a project without one
            writes it (Project index), and it waits while that runs */}
        <SettingsRow
          label={t('projectSections.general.useClaudeMd')}
          description={t('projectSections.general.useClaudeMdDescription')}
        >
          <Switch
            checked={settings.useClaudeMd !== false && (!!projectIndex || isWritingClaudeMd)}
            onCheckedChange={(checked) => void toggleClaudeMd(checked)}
            disabled={isWritingClaudeMd}
            aria-label={t('projectSections.general.useClaudeMd')}
          />
        </SettingsRow>
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
        {/* Switching this on points Claude Code's own memory at .workbench/compeng and tells
            sessions to save what they learn; switching it off leaves every note in place */}
        <SettingsRow
          label={t('projectSections.general.selfImprove')}
          description={t('projectSections.general.selfImproveDescription')}
        >
          <Switch
            checked={selfImprove}
            onCheckedChange={(checked) => void toggleSelfImprove(checked)}
            disabled={isIndexing}
            aria-label={t('projectSections.general.selfImprove')}
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
