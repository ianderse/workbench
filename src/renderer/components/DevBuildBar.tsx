import { useTranslation } from 'react-i18next';
import { DEV_BUILD_BAR_HEIGHT, IS_DEV_BUILD } from '../lib/title-bar';

/**
 * "DEVELOPMENT BUILD" bar across the top of the window, shown only in `npm run dev` builds so they
 * can't be mistaken for the installed app. It uses the primary button's inverted colors (foreground
 * background, background text), takes the window controls' row (useTitleBarColors paints the
 * controls the same way) and stays above dialog backdrops; it also drags the window.
 */
export function DevBuildBar() {
  const { t } = useTranslation('common');
  if (!IS_DEV_BUILD) return null;

  return (
    <div
      className="electron-drag relative z-[60] flex shrink-0 select-none items-center justify-center bg-foreground text-xs font-semibold tracking-wider text-background"
      style={{ height: DEV_BUILD_BAR_HEIGHT }}
      role="status"
    >
      {t('labels.developmentBuild')}
    </div>
  );
}
