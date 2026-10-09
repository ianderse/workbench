import { useTranslation } from 'react-i18next';
import { IS_DEV_BUILD } from '../lib/title-bar';

/** Height (px) of the bar */
const BAR_HEIGHT = 20;
/** Messages in each half of the scrolling track: enough to fill very wide windows */
const MESSAGES_PER_HALF = 24;

/**
 * "DEVELOPMENT BUILD" strip at the top of the content area (under the window's top strip, next to
 * the sidebar), shown only in `npm run dev` builds so they can't be mistaken for the installed app.
 * It uses the primary button's inverted colors and scrolls the repeated message endlessly.
 */
export function DevBuildBar() {
  const { t } = useTranslation('common');
  if (!IS_DEV_BUILD) return null;

  const label = t('labels.developmentBuild');
  const half = (key: string) => (
    <div key={key} className="flex shrink-0 items-center" aria-hidden="true">
      {Array.from({ length: MESSAGES_PER_HALF }, (_, index) => (
        <span key={index} className="flex items-center gap-4 pl-4">
          {label}
          <span className="h-2.5 w-px bg-background/40" />
        </span>
      ))}
    </div>
  );

  return (
    <div
      className="flex shrink-0 select-none overflow-hidden bg-foreground text-[10px] font-semibold tracking-wider text-background"
      style={{ height: BAR_HEIGHT }}
      role="status"
      aria-label={label}
    >
      <div className="flex w-max animate-marquee motion-reduce:animate-none">
        {half('a')}
        {half('b')}
      </div>
    </div>
  );
}
