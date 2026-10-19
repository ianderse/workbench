/**
 * Tests for Clawd's geometry and the rules that drive him.
 */

import { describe, expect, it } from 'vitest';
import { ACT_LEN, CLAWD_SEQS, CLICK_ACTS, HEALTH_TIERS, heartHalves, stepAct } from './animations';
import { HEART_BY_COLS, HEART_COLS, HEART_FULL, heartColumns } from './heart';
import { MASCOT_PY, getClawdGeo, getSoulGeo, makeFrame } from './sprite';

describe('heartHalves', () => {
  it('has no hearts to show without usage data', () => {
    expect(heartHalves(null)).toBeNull();
  });

  it('is full at zero usage and empty only at the limit', () => {
    expect(heartHalves(0)).toBe(6);
    expect(heartHalves(99)).toBe(1);
    expect(heartHalves(100)).toBe(0);
  });

  it('never goes below zero when the limit is overshot', () => {
    expect(heartHalves(130)).toBe(0);
  });

  it('spends about one half every 16.7%', () => {
    // Ceiling, so a half is lost only once the band is fully crossed
    expect(heartHalves(16)).toBe(6);
    expect(heartHalves(17)).toBe(5);
    expect(heartHalves(50)).toBe(3);
    expect(heartHalves(84)).toBe(1);
  });

  it('matches a health tier for every count it can return', () => {
    for (let halves = 0; halves <= 6; halves++) {
      expect(HEALTH_TIERS[halves]).toBeDefined();
    }
  });
});

describe('sprite geometry', () => {
  it('draws a body and two eyes when standing', () => {
    const geo = getClawdGeo(makeFrame());
    expect(geo.body.length).toBeGreaterThan(0);
    expect(geo.eyes.length).toBeGreaterThan(0);
    expect(geo.sand).toHaveLength(0);
    expect(geo.fx).toHaveLength(0);
  });

  it('returns the very same object for a frame it has already built', () => {
    expect(getClawdGeo(makeFrame())).toBe(getClawdGeo(makeFrame()));
  });

  it('looks different to the left than to the right', () => {
    const left = getClawdGeo(makeFrame({ look: -1 }));
    const right = getClawdGeo(makeFrame({ look: 1 }));
    expect(JSON.stringify(left.eyes)).not.toBe(JSON.stringify(right.eyes));
  });

  it('turns the body upside down when he lies legs up', () => {
    const up = getClawdGeo(makeFrame());
    const over = getClawdGeo(makeFrame({ flip: true, eyes: 'x' }));
    expect(JSON.stringify(over.body)).not.toBe(JSON.stringify(up.body));
    // The face is near the top of the frame standing up and near the bottom lying over
    const top = (rects: typeof up.eyes) => Math.min(...rects.map((r) => r.y));
    expect(top(over.eyes)).toBeGreaterThan(top(up.eyes));
  });

  it('piles up sand and hides most of him once he has burrowed', () => {
    const geo = getClawdGeo(makeFrame({ dig: 4, eyes: 'closed' }));
    expect(geo.sand.length).toBeGreaterThan(0);
    expect(geo.body.length).toBeLessThan(getClawdGeo(makeFrame()).body.length);
  });

  it('clips whatever a sideways shift pushes out of the frame', () => {
    const shifted = getClawdGeo(makeFrame({ x: -6 }));
    expect(shifted.body.every((r) => r.x >= 0)).toBe(true);
    expect(shifted.body.length).toBeLessThan(getClawdGeo(makeFrame()).body.length);
  });

  it('adds dust at both sides while crouching', () => {
    expect(getClawdGeo(makeFrame({ off: 1, poof: 'wave' })).fx.length).toBe(6);
    // Dust only shows while he is actually down
    expect(getClawdGeo(makeFrame({ off: 0, poof: 'wave' })).fx).toHaveLength(0);
  });

  it('keeps every rectangle one pixel tall', () => {
    const geo = getClawdGeo(makeFrame());
    expect(geo.body.every((r) => r.h === MASCOT_PY)).toBe(true);
  });
});

describe('animations', () => {
  it('knows how long each act runs', () => {
    for (const id of Object.keys(CLAWD_SEQS)) {
      expect(ACT_LEN[id]).toBe(CLAWD_SEQS[id].length);
    }
    for (const id of ['wave', 'stretch', 'yawn', 'stumble', 'soul', 'burrow', 'unburrow', 'stir']) {
      expect(ACT_LEN[id]).toBeGreaterThan(0);
    }
  });

  it('only offers click animations that start in place', () => {
    expect(CLICK_ACTS.length).toBeGreaterThan(0);
    for (const id of CLICK_ACTS) {
      expect(CLAWD_SEQS[id][0].x).toBe(0);
      // Celebrating is for a window reset, not for being petted
      expect(id).not.toBe('celebrate');
    }
  });

  it('plays every frame of every act without falling over', () => {
    for (const id of Object.keys(ACT_LEN)) {
      for (let t = 0; t < ACT_LEN[id]; t++) {
        const state = stepAct(id, t);
        expect(() => getClawdGeo(state.frame)).not.toThrow();
      }
    }
  });

  it('cheers only while celebrating', () => {
    expect(stepAct('celebrate', 0).bubble).toBe('!');
    expect(stepAct('jump', 0).bubble).toBe('');
  });

  it('digs in over the burrow and climbs back out', () => {
    expect(stepAct('burrow', ACT_LEN.burrow - 1).frame.dig).toBe(4);
    expect(stepAct('unburrow', ACT_LEN.unburrow - 1).frame.dig).toBe(0);
  });

  it('lets the soul out and pulls it back in', () => {
    expect(stepAct('soul', 0).soul).toBe(0);
    expect(stepAct('soul', 30).soul).toBeGreaterThan(15);
    expect(stepAct('soul', ACT_LEN.soul - 1).soul).toBe(0);
  });
});

describe('soul geometry', () => {
  it('runs a thread from the mouth up to the body of the soul', () => {
    const rects = getSoulGeo(20, 0);
    expect(rects.length).toBeGreaterThan(0);
    // Everything sits above the mouth, which is the origin
    expect(rects.every((r) => r.y < 0)).toBe(true);
  });
});

describe('heart geometry', () => {
  const widthOf = (rects: typeof HEART_FULL) =>
    rects.length ? Math.max(...rects.map((r) => r.x + r.w)) : 0;

  it('has a step for every pixel column, from empty to whole', () => {
    expect(HEART_BY_COLS).toHaveLength(HEART_COLS + 1);
    expect(HEART_BY_COLS[0]).toHaveLength(0);
    expect(HEART_BY_COLS[HEART_COLS]).toBe(HEART_FULL);
  });

  it('grows left to right and never past the whole heart', () => {
    const full = widthOf(HEART_FULL);
    let previous = 0;
    for (const rects of HEART_BY_COLS) {
      const width = widthOf(rects);
      expect(width).toBeGreaterThanOrEqual(previous);
      expect(width).toBeLessThanOrEqual(full);
      previous = width;
    }
  });

  it('fills by column rather than snapping to halves', () => {
    // Seven steps per heart, so the three together read to about 5%
    expect(new Set(HEART_BY_COLS.map(widthOf)).size).toBe(HEART_COLS + 1);
  });
});

describe('heartColumns', () => {
  it('shows nothing only when a heart is genuinely empty', () => {
    expect(heartColumns(0)).toBe(0);
    // Any sliver left still lights a column, so hearts go dark only at the limit
    expect(heartColumns(0.001)).toBe(1);
  });

  it('shows the whole heart when it is full', () => {
    expect(heartColumns(1)).toBe(HEART_COLS);
  });

  it('rises with the fill', () => {
    expect(heartColumns(0.5)).toBe(4);
    expect(heartColumns(0.25)).toBe(2);
    let previous = -1;
    for (let i = 0; i <= 20; i++) {
      const cols = heartColumns(i / 20);
      expect(cols).toBeGreaterThanOrEqual(previous);
      previous = cols;
    }
  });

  it('clamps a fill outside 0..1', () => {
    expect(heartColumns(-1)).toBe(0);
    expect(heartColumns(3)).toBe(HEART_COLS);
  });
});
