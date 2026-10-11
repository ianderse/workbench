import { useTranslation } from 'react-i18next';
import type { Project, ProjectSettings as ProjectSettingsType, AutoBuildVersionInfo, ProjectEnvConfig } from '../../../../shared/types';
import { GeneralSettings } from '../../project-settings/GeneralSettings';
import { KnowledgeSettings } from '../../project-settings/KnowledgeSettings';
import { BranchSettings } from '../../project-settings/BranchSettings';
import { InitializationGuard } from '../common/InitializationGuard';
import type { ProjectSettingsSection } from '../ProjectSettingsContent';

interface SectionRouterProps {
  activeSection: ProjectSettingsSection;
  project: Project;
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
  versionInfo: AutoBuildVersionInfo | null;
  isCheckingVersion: boolean;
  isUpdating: boolean;
  envConfig: ProjectEnvConfig | null;
  isLoadingEnv: boolean;
  envError: string | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
  handleInitialize: () => Promise<void>;
}

/**
 * Routes to the appropriate settings section based on activeSection.
 * Handles initialization guards and section-specific configurations.
 */
export function SectionRouter({
  activeSection,
  project,
  settings,
  setSettings,
  versionInfo,
  isCheckingVersion,
  isUpdating,
  envConfig,
  isLoadingEnv,
  envError,
  updateEnvConfig,
  handleInitialize
}: SectionRouterProps) {
  const { t } = useTranslation('settings');

  switch (activeSection) {
    case 'general':
      return (
        <>
          <GeneralSettings
            project={project}
            settings={settings}
            setSettings={setSettings}
            versionInfo={versionInfo}
            isCheckingVersion={isCheckingVersion}
            isUpdating={isUpdating}
            handleInitialize={handleInitialize}
          />
          {project.autoBuildPath && (
            <BranchSettings
              projectPath={project.path}
              settings={settings}
              setSettings={setSettings}
              envConfig={envConfig}
              updateEnvConfig={updateEnvConfig}
            />
          )}
        </>
      );

    case 'knowledge':
      return (
        <InitializationGuard
          initialized={!!project.autoBuildPath}
          title={t('projectSections.knowledge.title')}
          description={t('projectSections.knowledge.description')}
        >
          <KnowledgeSettings settings={settings} setSettings={setSettings} />
        </InitializationGuard>
      );

    default:
      return null;
  }
}
