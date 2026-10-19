/**
 * The three hearts in the popover's header: how much of the 5-hour limit is left.
 *
 * They fill by pixel column, so the three together read to about 5% rather than snapping to
 * thirds. A half that has just been lost blinks for a couple of seconds, and the last hearts beat.
 */

import { useTranslation } from 'react-i18next';
import { HEART_BY_COLS, HEART_FULL, HEART_H, HEART_W, heartColumns } from './clawd/heart';

/** How many hearts the limit is spread across */
const HEARTS = 3;

interface HeartsProps {
  /** How much of the limit is left, 0..1, or null when usage is unknown */
  fraction: number | null;
  /** Scale of the beat */
  beat: number;
}

export function Hearts({ fraction, beat }: HeartsProps) {
  const { t } = useTranslation(['common']);
  if (fraction == null) return null;

  const title = t('common:usage.heartsLeft', { percent: Math.round(fraction * 100) });

  return (
    <div className="flex items-center gap-[2.5px]" title={title}>
      {Array.from({ length: HEARTS }, (_, i) => {
        // The limit runs across the hearts left to right: this one's share of what is left
        const cols = heartColumns(Math.min(1, Math.max(0, fraction * HEARTS - i)));
        return (
          <svg
            key={i}
            width={HEART_W}
            height={HEART_H}
            viewBox={`0 0 ${HEART_W} ${HEART_H}`}
            aria-hidden="true"
            className="overflow-visible"
            style={{ transform: `scale(${beat})` }}
            shapeRendering="crispEdges"
          >
            {HEART_FULL.map((r, k) => (
              <rect
                key={k} x={r.x} y={r.y} width={r.w} height={r.h}
                fill="currentColor" className="text-muted-foreground/40"
              />
            ))}
            {HEART_BY_COLS[cols].map((r, k) => (
              <rect key={k} x={r.x} y={r.y} width={r.w} height={r.h} fill="#F87171" />
            ))}
          </svg>
        );
      })}
    </div>
  );
}
