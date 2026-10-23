import type { Project, ProjectSettings as ProjectSettingsType, AutoBuildVersionInfo } from '../../../../shared/types';
import { GeneralSettings } from '../../project-settings/GeneralSettings';
import { KnowledgeSettings } from '../../project-settings/KnowledgeSettings';
import { ProjectTaskSettings } from '../../project-settings/ProjectTaskSettings';
import { BranchSettings } from '../../project-settings/BranchSettings';
import type { ProjectSettingsSection } from '../ProjectSettingsContent';

interface SectionRouterProps {
  activeSection: ProjectSettingsSection;
  project: Project;
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
  versionInfo: AutoBuildVersionInfo | null;
  isCheckingVersion: boolean;
  isUpdating: boolean;
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
  handleInitialize
}: SectionRouterProps) {
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
          {/* Kept in the project's .workbench folder, so they need an initialized project */}
          {project.autoBuildPath && (
            <>
              <KnowledgeSettings projectId={project.id} settings={settings} setSettings={setSettings} />
              <ProjectTaskSettings settings={settings} setSettings={setSettings} />
              <BranchSettings
                projectPath={project.path}
                settings={settings}
                setSettings={setSettings}
              />
            </>
          )}
        </>
      );

    default:
      return null;
  }
}
