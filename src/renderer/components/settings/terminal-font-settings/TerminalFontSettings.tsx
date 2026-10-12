import { useTranslation } from 'react-i18next';
import { SettingsRow, SegmentedControl, type SegmentedOption } from '../SettingsRow';
import { useTerminalFontSettingsStore } from '../../../stores/terminal-font-settings-store';
import type { TerminalFontSettings as TerminalSettingsValues } from '../../../stores/terminal-font-settings-store';
import { SCROLLBACK_PRESETS } from '../../../lib/font-options';

/**
 * Terminal rows for General > Appearance (after the command line font rows): cursor style and
 * scrollback limit. Values live in the terminal settings store (localStorage) and apply to open
 * terminals immediately.
 */
export function TerminalFontSettings() {
  const { t } = useTranslation('settings');

  const cursorStyle = useTerminalFontSettingsStore((state) => state.cursorStyle);
  const scrollback = useTerminalFontSettingsStore((state) => state.scrollback);
  const applySettings = useTerminalFontSettingsStore((state) => state.applySettings);
  const handleSettingChange = <K extends keyof TerminalSettingsValues>(key: K, value: TerminalSettingsValues[K]) => {
    applySettings({ [key]: value });
  };

  const cursorStyleOptions: SegmentedOption<TerminalSettingsValues['cursorStyle']>[] = [
    { value: 'block', label: t('terminalFonts.cursorConfig.styleBlock', { defaultValue: 'Block' }) },
    { value: 'underline', label: t('terminalFonts.cursorConfig.styleUnderline', { defaultValue: 'Underline' }) },
    { value: 'bar', label: t('terminalFonts.cursorConfig.styleBar', { defaultValue: 'Bar' }) },
  ];
  const scrollbackOptions: SegmentedOption<string>[] = SCROLLBACK_PRESETS.map((value) => ({
    value: String(value),
    label: t('terminalFonts.performanceConfig.kValue', { defaultValue: '{{value}}K', value: value / 1000 }),
  }));

  return (
    <>
      <SettingsRow
        label={t('terminalFonts.cursorConfig.cursorStyle', { defaultValue: 'Cursor style' })}
        description={t('terminalFonts.cursorConfig.cursorStyleDescription', {
          defaultValue: 'Choose the appearance of the terminal cursor',
        })}
      >
        <SegmentedControl
          value={cursorStyle}
          options={cursorStyleOptions}
          onValueChange={(value) => handleSettingChange('cursorStyle', value)}
          ariaLabel={t('terminalFonts.cursorConfig.cursorStyle', { defaultValue: 'Cursor style' })}
        />
      </SettingsRow>

      <SettingsRow
        label={t('terminalFonts.performanceConfig.scrollback', { defaultValue: 'Scrollback limit' })}
        description={t('terminalFonts.performanceConfig.scrollbackDescription', {
          defaultValue: 'Maximum number of lines to keep in terminal history',
        })}
      >
        <SegmentedControl
          value={String(scrollback)}
          options={scrollbackOptions}
          onValueChange={(value) => handleSettingChange('scrollback', Number(value))}
          ariaLabel={t('terminalFonts.performanceConfig.scrollback', { defaultValue: 'Scrollback limit' })}
        />
      </SettingsRow>
    </>
  );
}
