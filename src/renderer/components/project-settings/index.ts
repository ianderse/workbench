// Note: ProjectSettings component is deprecated - use unified AppSettings instead
export { GeneralSettings } from './GeneralSettings';
export { SecuritySettings } from './SecuritySettings';
export { useProjectSettings } from './hooks/useProjectSettings';
export type { UseProjectSettingsReturn } from './hooks/useProjectSettings';

// New refactored components for ProjectSettings dialog
export { NotificationsSection } from './NotificationsSection';

// Utility components
export { StatusBadge } from './StatusBadge';
