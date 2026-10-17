import { RefreshCw, Download } from 'lucide-react';
import { ProjectIndexRows } from '../context/ProjectIndex';
import { LearningIndexRows } from '../context/LearningIndex';
import { MemoryIndexRows } from '../context/MemoryIndex';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import type {
  Project,
  ProjectSettings as ProjectSettingsType,
  AutoBuildVersionInfo
} from '../../../shared/types';

interface GeneralSettingsProps {
  project: Project;
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
  versionInfo: AutoBuildVersionInfo | null;
  isCheckingVersion: boolean;
  isUpdating: boolean;
  handleInitialize: () => Promise<void>;
}

/**
 * Project page's first section: initialize Workbench for the project, then its project index
 * and Graphify memory graph (the Knowledge, Tasks and Branches sections follow it).
 */
export function GeneralSettings({
  project,
  isUpdating,
  handleInitialize
}: GeneralSettingsProps) {
  const { t } = useTranslation(['settings']);

  return (
    <>
      <SettingsSection title={t('projectPages.general.autoBuildTitle')}>
        <SettingsRows>
          {!project.autoBuildPath ? (
            <SettingsRow
              label={t('projectPages.general.notInitialized')}
              description={t('projectPages.general.notInitializedDescription')}
            >
              <Button variant="outline" size="sm" onClick={handleInitialize} disabled={isUpdating} className="gap-2">
                {isUpdating ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                    {t('projectPages.general.initializing')}
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4" strokeWidth={1.75} />
                    {t('projectPages.general.initialize')}
                  </>
                )}
              </Button>
            </SettingsRow>
          ) : (
            <>
              <ProjectIndexRows projectId={project.id} />
              <LearningIndexRows projectId={project.id} />
              <MemoryIndexRows projectId={project.id} />
            </>
          )}
        </SettingsRows>
      </SettingsSection>

    </>
  );
}
