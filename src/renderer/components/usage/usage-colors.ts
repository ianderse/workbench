/**
 * Usage thresholds and the colours that go with them.
 *
 * Shared by the sidebar badge and the breakdown popover so the two always agree.
 */

/** Red: at or near the limit */
const THRESHOLD_CRITICAL = 95;
/** Orange: very high usage */
export const THRESHOLD_WARNING = 91;
/** Yellow: moderate usage. Below this is normal (green). */
export const THRESHOLD_ELEVATED = 71;

/** Text colour for a usage percentage */
export const getColorClass = (percent: number): string => {
  if (percent >= THRESHOLD_CRITICAL) return 'text-red-500';
  if (percent >= THRESHOLD_WARNING) return 'text-orange-500';
  if (percent >= THRESHOLD_ELEVATED) return 'text-yellow-500';
  return 'text-green-500';
};

/** Background/border colours for the badge */
export const getBadgeColorClasses = (percent: number): string => {
  if (percent >= THRESHOLD_CRITICAL) return 'text-red-500 bg-red-500/10 border-red-500/20';
  if (percent >= THRESHOLD_WARNING) return 'text-orange-500 bg-orange-500/10 border-orange-500/20';
  if (percent >= THRESHOLD_ELEVATED) return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20';
  return 'text-green-500 bg-green-500/10 border-green-500/20';
};

/** Fill of a usage bar */
export const getBarColorClass = (percent: number): string => {
  if (percent >= THRESHOLD_CRITICAL) return 'bg-red-500';
  if (percent >= THRESHOLD_WARNING) return 'bg-orange-500';
  if (percent >= THRESHOLD_ELEVATED) return 'bg-yellow-500';
  return 'bg-green-500';
};
