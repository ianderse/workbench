import { TITLE_BAR_OVERLAY_HEIGHT } from '../../shared/constants';

// macOS draws its own traffic lights (the sidebar header leaves room for them); on Windows/Linux
// the window controls overlay the top-right corner, so content areas start below them.
// The renderer can't reach the platform module, so detect macOS like the shortcut hints do.
const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;

/** `npm run dev` build: a red "DEVELOPMENT BUILD" bar runs across the top of the window */
export const IS_DEV_BUILD = import.meta.env.DEV;

/** Height (px) of the development build bar: the window controls' row, or room for the traffic lights */
export const DEV_BUILD_BAR_HEIGHT = IS_MAC ? 28 : TITLE_BAR_OVERLAY_HEIGHT;

/**
 * Height (px) of the draggable strip at the top of content areas, under the window controls
 * (none in development builds, where the bar above already takes that row)
 */
export const TITLE_BAR_STRIP_HEIGHT = IS_MAC || IS_DEV_BUILD ? 0 : TITLE_BAR_OVERLAY_HEIGHT;
