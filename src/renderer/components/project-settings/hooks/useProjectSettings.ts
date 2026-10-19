import { useState, useEffect } from 'react';
import {
  updateProjectSettings,
  checkProjectVersion,
  initializeProject
} from '../../../stores/project-store';
import type {
  Project,
  ProjectSettings as ProjectSettingsType,
  AutoBuildVersionInfo
} from '../../../../shared/types';

export interface UseProjectSettingsReturn {
  // Settings state
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
  isSaving: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;

  // Version info
  versionInfo: AutoBuildVersionInfo | null;
  isCheckingVersion: boolean;
  isUpdating: boolean;

  // Password visibility toggles
  showClaudeToken: boolean;
  setShowClaudeToken: React.Dispatch<React.SetStateAction<boolean>>;

  // Collapsible sections
  expandedSections: Record<string, boolean>;
  toggleSection: (section: string) => void;

  // Actions
  handleInitialize: () => Promise<void>;
  handleSave: (onClose: () => void) => Promise<void>;
}

export function useProjectSettings(
  project: Project,
  open: boolean
): UseProjectSettingsReturn {
  const [settings, setSettings] = useState<ProjectSettingsType>(project.settings);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<AutoBuildVersionInfo | null>(null);
  const [isCheckingVersion, setIsCheckingVersion] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  // Password visibility toggles
  const [showClaudeToken, setShowClaudeToken] = useState(false);

  // Collapsible sections
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    claude: true,
    memory: false
  });

  // Reset settings when project changes
  useEffect(() => {
    setSettings(project.settings);
  }, [project]);

  // Check version when dialog opens
  useEffect(() => {
    const checkVersion = async () => {
      if (open && project.autoBuildPath) {
        setIsCheckingVersion(true);
        const info = await checkProjectVersion(project.id);
        setVersionInfo(info);
        setIsCheckingVersion(false);
      }
    };
    checkVersion();
  }, [open, project.id, project.autoBuildPath]);

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const handleInitialize = async () => {
    setIsUpdating(true);
    setError(null);
    try {
      const result = await initializeProject(project.id);
      if (result?.success) {
        const info = await checkProjectVersion(project.id);
        setVersionInfo(info);
      } else {
        setError(result?.error || 'Failed to initialize');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSave = async (onClose: () => void) => {
    setIsSaving(true);
    setError(null);

    try {
      const success = await updateProjectSettings(project.id, settings);
      if (!success) {
        setError('Failed to save settings');
        return;
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsSaving(false);
    }
  };

  return {
    settings,
    setSettings,
    isSaving,
    error,
    setError,
    versionInfo,
    isCheckingVersion,
    isUpdating,
    showClaudeToken,
    setShowClaudeToken,
    expandedSections,
    toggleSection,
    handleInitialize,
    handleSave
  };
}
