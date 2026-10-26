/**
 * Clawd's tick loop - the mood machine from the clawd-usage widget
 * (https://github.com/Enhed/clawd-usage-winwidget, lib/mascot-step.ps1), driven here by the
 * app's own tasks instead of Claude Code's session registry.
 *
 * Mood, checked top to bottom:
 *   session >= 100%        dead   - belly-up, X eyes
 *   a task awaits the user wait   - wide eyes, hops and waves
 *   a task is running      work   - runs edge to edge, focused squint
 *   tasks but all settled  idle   - wanders, looks around; dozes after 10 quiet minutes
 *   no tasks               sleep  - burrowed in the sand, only the eyes out, "z"s
 *
 * The timer only runs while the popover is open, and stands still for anyone who asked for
 * reduced motion.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ACT_LEN, CLAWD_FRAME_MS, CLAWD_SEQS, CLICK_ACTS, ENTRANCE_ACTS, HEALTH_TIERS,
  MOOD_FRAME_MS, heartHalves, stepAct, type Mood,
} from './animations';
import {
  BURROW_DIG, MASCOT_W, getClawdGeo, getSoulGeo, makeFrame,
  type ClawdGeo, type Rect,
} from './sprite';
import type { ClawdSkin } from './skins';

/** What the scene knows about the world each tick */
interface ClawdInput {
  /** 5-hour usage, 0-100, or null when there is no data */
  sessionPercent: number | null;
  /** ISO timestamp the 5-hour window resets at, to spot it rolling over */
  sessionReset?: string;
  /** Tasks the app is working on right now */
  busy: number;
  /** Tasks waiting for the user */
  waiting: number;
  /** Tasks that exist at all */
  total: number;
  /** How far the mascot may walk */
  span: number;
  /** Pointer x inside the scene, or null when the pointer is elsewhere */
  pointerX: number | null;
  /** The popover is open; the timer stops when it is not */
  active: boolean;
  /** What he wears */
  skin: ClawdSkin;
}

interface Particle { x: number; y: number; opacity: number }

export interface ClawdRender {
  geo: ClawdGeo;
  /** The skin the geometry was drawn in, for its colours */
  skin: ClawdSkin;
  /** Left edge of the mascot box */
  x: number;
  /** How far the box is lifted off the ground */
  lift: number;
  bubble: string;
  /** Picks the bubble's colour */
  bubbleKind: 'cheer' | 'note' | '';
  /** How high over the ground the bubble floats, bobbing as it goes */
  bubbleY: number;
  zzz: Particle & { size: number } | null;
  sweat: Particle | null;
  dust: Particle[];
  confetti: (Particle & { w: number; color: string })[];
  love: Particle | null;
  soul: { rects: Rect[]; x: number; y: number; opacity: number } | null;
  /**
   * What the hearts should draw: how much of the limit is left, 0..1, or null when usage is
   * unknown. A just-lost half blinks for a moment, so this briefly holds the older value.
   */
  shownFraction: number | null;
  /** Hearts beat when there is almost nothing left */
  beat: number;
}

const CONFETTI_COLORS = ['#F87171', '#FBBF24', '#4ADE80', '#60A5FA', '#A78BFA', '#D77757'];

interface Mz {
  x: number; dir: number; target: number | null; look: number;
  tick: number; blinkAt: number;
  mood: Mood; cur: Mood; crit: boolean; idleSince: number;
  act: string | null; actT: number;
  pct: number | null; halves: number | null; fraction: number | null;
  lostT: number; lostFrom: number | null;
  loveT: number; noteT: number; confT: number;
  busy: number; waiting: number; lastReset: string | null; lastPct: number | null;
  buried: boolean;
  confetti: { x: number; y: number; v: number; d: number }[];
}

function newMz(): Mz {
  return {
    x: -1, dir: 1, target: null, look: 0,
    tick: 0, blinkAt: 30,
    mood: 'idle', cur: 'idle', crit: false, idleSince: Date.now(),
    act: null, actT: 0,
    pct: null, halves: null, fraction: null, lostT: -1, lostFrom: null,
    loveT: -1, noteT: -1, confT: -1,
    busy: -1, waiting: 0, lastReset: null, lastPct: null,
    buried: false,
    confetti: Array.from({ length: 12 }, () => ({ x: 0, y: 0, v: 0, d: 0 })),
  };
}

const rnd = (n: number) => Math.floor(Math.random() * n);

/** Nobody asked for a running crab: with this on, the scene stands still */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Frame of the soul act the still scene borrows: the spirit out, hanging over the body */
const SOUL_HANG_FRAME = 30;

/** How long a click's still answer is held before the scene goes back to resting */
const STILL_PET_MS = 1_200;

export function useClawd(input: ClawdInput) {
  const mz = useRef<Mz>(newMz());
  const live = useRef(input);
  live.current = input;
  const [render, setRender] = useState<ClawdRender | null>(null);
  /** Click handler lives in a ref so the scene never has to re-subscribe */
  const pet = useRef<() => void>(() => {});

  // Reduced motion: no timer, just the crab standing in the middle of the scene. The usage is
  // in the dependencies, so the hearts still follow the limit as it is used up - with nothing
  // moving, the tick loop is no longer there to pick the new value up.
  useEffect(() => {
    if (!input.active || !prefersReducedMotion()) return;
    const pct = input.sessionPercent;
    mz.current.pct = pct;
    const gone = heartHalves(pct) === 0;
    const x = Math.max(0, input.span - MASCOT_W) / 2;

    /** The standing scene, holding whatever a click has just left in it */
    const paint = (reaction: 'love' | 'soul' | null): void => {
      // The soul's own frame comes from the animation, stopped where the spirit hangs at the top
      const act = reaction === 'soul' ? stepAct('soul', SOUL_HANG_FRAME) : null;
      setRender({
        geo: getClawdGeo(act ? act.frame : makeFrame(gone ? { flip: true, eyes: 'x' } : {}), input.skin),
        skin: input.skin,
        x, lift: 0,
        bubble: '', bubbleKind: '', bubbleY: 22, zzz: null, sweat: null, dust: [], confetti: [],
        // The heart over the middle of him, at full opacity, halfway along the path it would fly
        love: reaction === 'love' ? { x: x + MASCOT_W / 2 - 5, y: 30, opacity: 1 } : null,
        soul: act ? { rects: getSoulGeo(act.soul, act.soulT), x: x + 9.5 * 2, y: 6 * 2.2, opacity: 0.85 } : null,
        beat: 1,
        shownFraction: pct == null ? null : Math.min(1, Math.max(0, (100 - pct) / 100)),
      });
    };

    paint(null);

    // Asking for reduced motion asks for less animation nobody set off, not for a mascot that
    // ignores being clicked, so petting still answers - it just answers standing still. He shows
    // the same heart as the walking crab, or, with the limit used up, the same soul leaving his
    // body, each held in place for a moment instead of floating up, and no click animation plays.
    let reset: ReturnType<typeof setTimeout> | undefined;
    pet.current = () => {
      clearTimeout(reset);
      paint(gone ? 'soul' : 'love');
      reset = setTimeout(() => paint(null), STILL_PET_MS);
    };

    return () => {
      clearTimeout(reset);
      pet.current = () => {};
    };
  }, [input.active, input.sessionPercent, input.span, input.skin]);

  useEffect(() => {
    if (!input.active || prefersReducedMotion()) return;

    const m = mz.current;

    const startAct = (name: string) => {
      m.act = name;
      m.actT = 0;
      if (name === 'celebrate') startConfetti();
    };

    const startConfetti = () => {
      for (const c of m.confetti) {
        c.x = m.x - 12 + Math.random() * (MASCOT_W + 24);
        c.y = 34 + Math.random() * 12;
        c.v = 0.9 + Math.random() * 1.2;
        c.d = (Math.random() - 0.5) * 0.8;
      }
      m.confT = 0;
    };

    // Petting: a random Claude Code animation and a heart. Lying with the limit used up, his
    // soul leaves the body instead; burrowed, he only stirs without coming out.
    pet.current = () => {
      if (m.cur === 'dead') {
        if (!m.act) startAct('soul');
        return;
      }
      m.loveT = 0;
      if (m.buried && m.cur === 'sleep') {
        if (!m.act) startAct('stir');
        return;
      }
      if (m.act) return;
      startAct(CLICK_ACTS[rnd(CLICK_ACTS.length)]);
    };

    /** Where to look when the pointer is over the scene: -1, 0, 1, or null for no pointer */
    const mouseLook = (): number | null => {
      const px = live.current.pointerX;
      if (px == null) return null;
      const cx = m.x + MASCOT_W / 2;
      if (px > cx + 10) return 1;
      if (px < cx - 10) return -1;
      return 0;
    };

    const setMood = () => {
      const { busy, waiting, total, sessionPercent, sessionReset } = live.current;
      const pct = sessionPercent;

      let mood: Mood;
      if (pct != null && pct >= 100) mood = 'dead';
      else if (waiting) mood = 'wait';
      else if (busy) mood = 'work';
      else if (total) mood = 'idle';
      else mood = 'sleep';

      if (mood !== m.mood) m.idleSince = Date.now();
      m.mood = mood;

      // A task finished its work (rather than stopping to wait for us) - jump.
      if (m.busy > 0 && busy < m.busy && waiting <= m.waiting && !m.act) startAct('jump');
      m.busy = busy;
      m.waiting = waiting;
      m.crit = pct != null && pct >= 91;
      m.pct = pct;

      // The 5-hour window reset: the reset time moved forward and the percent dropped.
      if (sessionReset) {
        if (m.lastReset && sessionReset > m.lastReset && m.lastPct != null && pct != null && pct < m.lastPct) {
          startAct('celebrate');
        }
        m.lastReset = sessionReset;
        m.lastPct = pct;
      }
    };

    const step = () => {
      m.tick++;
      setMood();

      const width = live.current.span;
      const span = Math.max(0, width - MASCOT_W);
      // He comes in at the middle, but only once the scene has reported its width: the first
      // ticks can run before it does, and taking that zero for his starting point would park him
      // at the left edge with nothing left to move him back. A scene narrower than he is reports
      // a width all the same, and there the single position it has for him is the left edge - so
      // it is the width, not the walkable span it leaves, that says whether to keep waiting.
      if (m.x < 0) {
        if (width <= 0) return MOOD_FRAME_MS;
        m.x = span / 2;
      }
      if (m.x > span) m.x = span;
      // The scene may have narrowed since the target was picked, or he walks into the wall forever.
      if (m.target != null && m.target > span) m.target = span;

      let mood: Mood = m.mood;
      const halves = heartHalves(m.pct);
      // Zero hearts - always lies down.
      if (halves === 0) mood = 'dead';
      // Health from the hearts; no data means "fine".
      const tier = HEALTH_TIERS[halves ?? 5];
      const perky = tier.speed >= 0.9;   // lively enough to jump and whistle

      // The pointer wakes him; long silence and he dozes standing up.
      if (live.current.pointerX != null) m.idleSince = Date.now();
      if (mood === 'idle' && Date.now() - m.idleSince >= 10 * 60_000) mood = 'doze';

      // Falling asleep he burrows once the current animation finishes; waking up he climbs
      // straight out, whatever is playing.
      if (mood === 'sleep') {
        if (!m.buried && !m.act) { m.buried = true; startAct('burrow'); }
      } else if (m.buried) {
        m.buried = false;
        startAct('unburrow');
      }

      const f = makeFrame({ look: m.look });
      let lift = 0;
      let soulH = 0;
      let soulT = 0;

      // Work is over - the edge he was running to is no longer a reason to walk there.
      if (m.cur === 'work' && mood !== 'work') m.target = null;
      m.cur = mood;

      let bubble = '';
      let bubbleKind: ClawdRender['bubbleKind'] = '';
      let zzz = false;
      let canBlink = true;
      let dusty = false;

      if (m.act) {
        const a = stepAct(m.act, m.actT);
        Object.assign(f, a.frame);
        bubble = a.bubble;
        if (bubble) bubbleKind = 'cheer';
        lift = a.lift;
        soulH = a.soul;
        soulT = a.soulT;
        canBlink = false;
        m.actT++;
        if (m.actT >= (ACT_LEN[m.act] ?? 1)) m.act = null;
      } else if (mood === 'sleep') {
        f.dig = BURROW_DIG; f.eyes = 'closed'; f.look = 0; zzz = true;
      } else if (mood === 'doze') {
        // Nods off, and sometimes startles and goggles.
        f.look = 0;
        const p = m.tick % 70;
        if (p < 6) {
          f.eyes = 'wide';
          if (p < 2) lift = 1.5;
        } else {
          f.eyes = 'blink'; zzz = true;
        }
      } else if (mood === 'dead') {
        f.flip = true; f.eyes = 'x'; f.look = 0;
        // Occasionally twitches his legs.
        const p = m.tick % 50;
        if (p < 6) f.feet = p % 2 ? 'left' : 'right';
      } else if (mood === 'wait') {
        f.eyes = 'wide';
        f.look = mouseLook() ?? 0;
        // Jumps and waves: hey, someone is waiting for you.
        const p = m.tick % 40;
        if (p < 8) {
          const k = p / 7;
          lift = 12 * k * (1 - k);
          f.arms = 'right';
        }
      } else {
        let speed: number;
        if (mood === 'work') {
          speed = 1.6 * tier.speed;
          // Runs from edge to edge.
          if (m.target == null) m.target = m.dir > 0 ? span : 0;
        } else {
          speed = 0.6 * tier.speed;
          if (m.target == null) {
            if (rnd(70) === 0) m.target = Math.random() * span;
            else if (rnd(45) === 0) m.look = rnd(3) - 1;
            else if (rnd(400) === 0) startAct((['wave', 'stretch', 'look'] as const)[rnd(3)]);
          }
        }

        let walking = false;
        if (m.target != null) {
          const d = m.target - m.x;
          if (Math.abs(d) <= speed) {
            m.x = m.target; m.target = null;
            if (mood === 'work') m.dir = -m.dir;
          } else {
            m.dir = Math.sign(d);
            m.x += speed * m.dir;
            m.look = m.dir;
            walking = true;
          }
        }

        if (walking) {
          // The less energy, the slower the steps.
          let stepLen = mood === 'work' ? 2 : 3;
          if (tier.speed < 0.8) stepLen++;
          if (tier.speed < 0.5) stepLen++;
          f.feet = Math.floor(m.tick / stepLen) % 2 ? 'left' : 'right';
          if (mood === 'work') {
            if (f.feet === 'left' && perky) lift = 1;
            dusty = true;
            if (perky && rnd(150) === 0) startAct('jump');
          } else if (perky && m.noteT < 0 && rnd(80) === 0) {
            m.noteT = 0;   // whistles while walking
          }
          if (tier.stumble && rnd(tier.stumble) === 0) startAct('stumble');
        } else if (m.crit) {
          // Limit running out - eyes dart nervously.
          m.look = Math.floor(m.tick / 5) % 2 ? -1 : 1;
        } else {
          // Standing - follows the pointer.
          const ml = mouseLook();
          if (ml != null) m.look = ml;
        }

        f.look = m.look;
        if (mood === 'work') f.eyes = 'focus';
        // Full of energy - jumps for joy; tired - yawns.
        if (!m.act) {
          if (tier.hop && rnd(tier.hop) === 0) startAct('jump');
          if (tier.yawn && rnd(tier.yawn) === 0) startAct('yawn');
        }
      }

      // Tired eyes on top of the normal and the working ones.
      if (tier.eyes && !m.act && (f.eyes === 'open' || f.eyes === 'focus')) f.eyes = tier.eyes;
      // Petted - pleased.
      if (m.loveT >= 0 && !m.act && f.eyes === 'open') f.eyes = 'happy';

      // Whistling: notes, if there is no other bubble.
      if (m.noteT >= 0) {
        if (!bubble && mood === 'idle') { bubble = '♪'; bubbleKind = 'note'; }
        m.noteT++;
        if (m.noteT >= 30) m.noteT = -1;
      }

      if (canBlink && f.eyes === 'open' && m.tick >= m.blinkAt) {
        f.eyes = 'blink';
        if (m.tick >= m.blinkAt + 1) m.blinkAt = m.tick + 25 + rnd(45);
      }

      // Barely alive - sways.
      let rx = m.x;
      if (tier.stagger && mood !== 'sleep' && mood !== 'dead') rx += 1.5 * Math.sin(m.tick / 3);

      // Hearts: the halves decide the health tier and when one is visibly lost, but what the
      // hearts draw is the limit left as a fraction, so they fill by pixel column.
      const fraction = m.pct == null ? null : Math.min(1, Math.max(0, (100 - m.pct) / 100));
      // A lost half blinks for a couple of seconds, showing what it was before.
      if (m.halves != null && halves != null && halves < m.halves) {
        m.lostT = 0; m.lostFrom = m.fraction;
      }
      m.halves = halves;
      let shownFraction = fraction;
      if (m.lostT >= 0) {
        if (m.lostT % 4 < 2) shownFraction = m.lostFrom;
        m.lostT++;
        if (m.lostT >= 16) m.lostT = -1;
      }
      m.fraction = fraction;
      // Last bit of health left - the hearts beat.
      let beat = 1;
      if (halves != null && halves > 0 && halves <= 2) {
        const p = m.tick % 12;
        if (p === 0) beat = 1.3; else if (p === 1) beat = 1.15;
      }

      // Sleep: a "z" floats up from behind his head and fades.
      let zzzOut: ClawdRender['zzz'] = null;
      if (zzz) {
        const p = (m.tick % 30) / 30;
        zzzOut = {
          x: m.x + 28 + 3 * Math.sin(p * 2 * Math.PI),
          y: (f.dig > 0 ? 9 : f.off > 0 ? 12 : 19) + 14 * p,
          opacity: 1 - p,
          size: 7 + 4 * p,
        };
      }

      // Session limit almost used up - sweats.
      let sweat: Particle | null = null;
      if ((m.crit || tier.sweat) && mood !== 'sleep' && mood !== 'dead') {
        const p = (m.tick % 20) / 20;
        sweat = { x: m.x + (f.look < 0 ? 31 : 2), y: -2 + 6 * p - lift, opacity: 1 - p };
      }

      // Dust from under his feet while running.
      const dust: Particle[] = [];
      if (dusty) {
        for (let i = 0; i < 3; i++) {
          const p = ((m.tick + i * 3) % 9) / 9;
          const dx = m.dir > 0 ? 4 - 8 * p - 2 * i : MASCOT_W - 6 + 8 * p + 2 * i;
          dust.push({ x: m.x + dx, y: 4 * p, opacity: 0.7 * (1 - p) });
        }
      }

      // Confetti: falls, drifts sideways and shimmers as it flips.
      const confetti: ClawdRender['confetti'] = [];
      if (m.confT >= 0) {
        m.confetti.forEach((c, i) => {
          c.y -= c.v; c.x += c.d;
          if (c.y > 0) {
            confetti.push({
              x: c.x, y: c.y, opacity: 1,
              w: Math.floor((m.tick + i) / 2) % 2 ? 2.5 : 1.2,
              color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
            });
          }
        });
        m.confT++;
        if (m.confT >= 45) m.confT = -1;
      }

      // Petted - a heart floats up.
      let love: Particle | null = null;
      if (m.loveT >= 0) {
        const k = m.loveT / 20;
        love = {
          x: m.x + MASCOT_W / 2 - 5 + 2 * Math.sin(k * 6),
          y: 23 + lift + 14 * k,
          opacity: 1 - k,
        };
        m.loveT++;
        if (m.loveT >= 20) m.loveT = -1;
      }

      // A spirit leaves the mouth of the lying Clawd and shimmers.
      const soul = soulH > 0.5
        ? {
            rects: getSoulGeo(soulH, soulT),
            x: m.x + 9.5 * 2,
            y: lift + 6 * 2.2,
            opacity: 0.7 + 0.15 * Math.sin(soulT / 1.7),
          }
        : null;

      setRender({
        geo: getClawdGeo(f, live.current.skin),
        skin: live.current.skin,
        x: rx, lift, bubble, bubbleKind,
        bubbleY: 22 + lift + 1.5 * Math.sin(m.tick / 3),
        zzz: zzzOut, sweat, dust, confetti, love, soul,
        shownFraction, beat,
      });

      return m.act && CLAWD_SEQS[m.act] ? CLAWD_FRAME_MS : MOOD_FRAME_MS;
    };

    startAct(ENTRANCE_ACTS[rnd(ENTRANCE_ACTS.length)]);

    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      const ms = step();
      timer = setTimeout(loop, ms);
    };
    loop();
    return () => clearTimeout(timer);
  }, [input.active]);

  return { render, pet: () => pet.current() };
}
