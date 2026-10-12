import { useTranslation } from 'react-i18next';
import { SettingsRow, SegmentedControl, type SegmentedOption } from './SettingsRow';
import { GraphColorIcon, GraphIcon } from '../icons/app-icons';
import { useSettingsStore } from '../../stores/settings-store';
import type { AppSettings, GraphStyle } from '../../../shared/types';

interface GraphStyleSelectorProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Graph style row (Appearance): an icon-only switch like the theme's, between the Graph page in
 * one muted color and colored by community with Graphify's palette. Applies right away.
 */
export function GraphStyleSelector({ settings, onSettingsChange }: GraphStyleSelectorProps) {
  const { t } = useTranslation('settings');
  const updateStoreSettings = useSettingsStore((state) => state.updateSettings);

  const handleChange = (graphStyle: GraphStyle) => {
    onSettingsChange({ ...settings, graphStyle });
    updateStoreSettings({ graphStyle });
  };

  const options: SegmentedOption<GraphStyle>[] = [
    { value: 'plain', label: t('theme.graphPlain'), icon: GraphIcon },
    { value: 'colorful', label: t('theme.graphColorful'), icon: GraphColorIcon }
  ];

  return (
    <SettingsRow label={t('theme.graphStyle')} description={t('theme.graphStyleDescription')}>
      <SegmentedControl
        value={settings.graphStyle ?? 'plain'}
        options={options}
        onValueChange={handleChange}
        ariaLabel={t('theme.graphStyle')}
        iconOnly
      />
    </SettingsRow>
  );
}
