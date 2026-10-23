import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { SettingsRows } from './SettingsRow';
import { ThemeSelector } from './ThemeSelector';
import { GraphStyleSelector } from './GraphStyleSelector';
import { WindowsShellSelector } from './WindowsShellSelector';
import { DisplaySettings } from './DisplaySettings';
import { FontSettings } from './FontSettings';
import type { AppSettings } from '../../../shared/types';

interface ThemeSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Appearance section: the theme and graph style switches, the Windows shell (Windows only), the font rows, then the display rows
 * (log order, GPU)
 */
export function ThemeSettings({ settings, onSettingsChange }: ThemeSettingsProps) {
  const { t } = useTranslation('settings');

  return (
    <SettingsSection
      title={t('theme.title')}
      description={t('theme.description')}
    >
      <SettingsRows>
        <ThemeSelector settings={settings} onSettingsChange={onSettingsChange} />
        <GraphStyleSelector settings={settings} onSettingsChange={onSettingsChange} />
        <WindowsShellSelector settings={settings} onSettingsChange={onSettingsChange} />
        <FontSettings settings={settings} onSettingsChange={onSettingsChange} />
        <DisplaySettings settings={settings} onSettingsChange={onSettingsChange} />
      </SettingsRows>
    </SettingsSection>
  );
}
