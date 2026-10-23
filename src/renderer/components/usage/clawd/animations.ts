/**
 * Clawd's animations - the same sequences Claude Code plays in the terminal, plus the moods
 * driven by usage and by what the app is doing.
 *
 * Ported from the clawd-usage widget (https://github.com/Enhed/clawd-usage-winwidget,
 * lib/mascot.ps1). Claude Code's own animations run at 60 ms per frame, everything else at 90 ms.
 */

import { BURROW_DIG, makeFrame, type ClawdFrame } from './sprite';

/** Claude Code plays its animations at this rate */
export const CLAWD_FRAME_MS = 60;
/** Everything else - walking, moods, one-off poses - ticks slower */
export const MOOD_FRAME_MS = 90;

export type Mood = 'sleep' | 'doze' | 'idle' | 'work' | 'wait' | 'dead';

/** A sequence frame: a pose plus where it sits relative to the normal standing position */
type SeqFrame = Pick<ClawdFrame, 'eyes' | 'arms' | 'feet' | 'off' | 'x' | 'facing' | 'poof' | 'shadow'>;

const POSES: Record<string, string> = {
  'default':    'open/down/both',
  'arms-up':    'open/up/both',
  'look-left':  'left/down/both',
  'look-right': 'right/down/both',
};

/**
 * n copies of one pose.
 *
 * `off` lowers the body by whole rows (1 crouched with the legs hidden, 3 fully hidden, negative
 * above the frame), `x` shifts it in glyph cells, `poof` adds dust puffs while crouching and
 * `shadow` the shadow of the hopping coin.
 */
function f(pose: string, n = 1, opts: Partial<SeqFrame> = {}): SeqFrame[] {
  const base: SeqFrame = {
    eyes: 'open', arms: 'down', feet: 'both',
    off: 0, x: 0, facing: '', poof: '', shadow: '',
    ...opts,
  };
  if (pose.startsWith('face:')) {
    base.facing = pose.slice(5);
  } else {
    const [eyes, arms, feet] = (POSES[pose] ?? pose).split('/');
    base.eyes = eyes; base.arms = arms; base.feet = feet;
  }
  return Array.from({ length: n }, () => base);
}

/** Crouch before the jump */
const cr = [...f('default', 1, { off: 1, poof: 'dot' }), ...f('default', 1, { off: 1, poof: 'wave' })];
/** Rest */
const bo = f('default');
/** Blink at the end */
const ts = [...f('closed/down/both'), ...bo];

function turn(list: string[], shadow = ''): SeqFrame[] {
  return list.flatMap((p) => f(`face:${p}`, 1, { shadow }));
}

const jumpSeq = [...cr, ...f('arms-up', 3), ...bo, ...cr, ...f('arms-up', 3), ...bo];

const waddle: SeqFrame[] = [...f('look-right', 1, { x: -9 })];
for (let u = -6; u <= -1; u++) {
  waddle.push(...f(`right/down/${u % 2 === 0 ? 'left' : 'right'}`, 2, { x: u }));
}

/** Claude Code's click animations, frame for frame */
export const CLAWD_SEQS: Record<string, SeqFrame[]> = {
  jump: jumpSeq,
  look: [...f('look-right', 5), ...f('look-left', 5), ...bo],
  celebrate: [...jumpSeq, ...f('default', 3, { off: 1 })],
  skip: [
    ...f('default', 1, { off: 1, x: -9 }), ...f('arms-up', 2, { x: -6 }), ...f('default', 1, { x: -6 }),
    ...f('default', 1, { off: 1, x: -6 }), ...f('arms-up', 2, { x: -3 }), ...f('default', 1, { x: -3 }),
    ...f('default', 1, { off: 1, x: -3 }), ...f('arms-up', 2), ...cr, ...bo,
  ],
  spin: [...f('look-left', 2), ...f('look-right', 2), ...f('look-left', 2), ...f('arms-up', 3), ...bo],
  peekaboo: [
    ...f('default', 1, { off: 3 }), ...f('default', 3, { off: 2 }), ...f('look-right', 3, { off: 2 }),
    ...f('look-left', 3, { off: 2 }), ...f('default', 2, { off: 2 }), ...f('default', 1, { off: 1 }),
    ...f('arms-up', 4), ...f('default', 2), ...ts,
  ],
  drop: [
    ...f('arms-up', 1, { off: -3 }), ...f('arms-up', 2, { off: -2 }), ...f('arms-up', 2, { off: -1 }),
    ...f('arms-up', 1), ...cr, ...f('default', 3), ...ts,
  ],
  waddle: [...waddle, ...f('look-right', 2), ...f('default', 2), ...ts],
  peek: [
    ...f('look-right', 1, { x: -9 }), ...f('look-right', 5, { x: -6 }), ...f('look-right', 3, { x: -9 }),
    ...f('look-right', 4, { x: -5 }), ...f('arms-up', 2, { x: -3 }), ...f('arms-up', 2), ...cr, ...bo,
  ],
  wink: [...f('wink/down/both', 5), ...bo],
  boop: [
    ...f('closed/down/both', 1, { off: 1, poof: 'dot' }), ...f('closed/down/both', 2, { off: 1, poof: 'wave' }),
    ...f('look-left', 4), ...f('default', 2), ...ts,
  ],
  tap: [
    ...f('open/down/left', 2), ...f('open/down/right', 2), ...f('open/down/left', 2),
    ...f('open/down/right', 2), ...f('open/down/left', 1), ...f('open/down/right', 1),
    ...f('arms-up', 3), ...bo,
  ],
  sneeze: [
    ...f('closed/up/both', 4), ...f('closed/down/both', 2, { off: 1, poof: 'wave' }),
    ...f('closed/down/both', 2), ...f('default', 2), ...ts,
  ],
  turn: [
    ...turn(['right-12', 'right-30', 'right-55', 'right-75', 'edge']),
    ...turn(['back-105', 'back-125', 'back-150', 'back', 'back']),
    ...turn(['back-150', 'back-125', 'back-105', 'edge']),
    ...turn(['left-75', 'left-55', 'left-30', 'left-12']),
    ...bo,
  ],
  'coin-hop': [
    ...f('default', 2, { off: 1 }), ...f('arms-up', 1, { shadow: 'wide' }),
    ...turn(['right-55', 'edge', 'back-125', 'back'], 'narrow'),
    ...turn(['back-125', 'edge', 'left-55'], 'narrow'),
    ...f('arms-up', 1, { shadow: 'wide' }), ...cr, ...bo,
  ],
};

/** How long each one-off animation runs, in frames */
export const ACT_LEN: Record<string, number> = {
  wave: 24, stretch: 22, yawn: 22, stumble: 20, soul: 66,
  burrow: 30, unburrow: 28, stir: 22,
};
for (const id of Object.keys(CLAWD_SEQS)) ACT_LEN[id] = CLAWD_SEQS[id].length;

/** On click, as in Claude Code: everything that starts in place, with no slide-in */
export const CLICK_ACTS = Object.keys(CLAWD_SEQS)
  .filter((k) => CLAWD_SEQS[k][0].x === 0 && k !== 'celebrate');

/** On open, an entrance from any animation, as on the first launch of a new version */
export const ENTRANCE_ACTS = Object.keys(CLAWD_SEQS).filter((k) => k !== 'celebrate');

/** Frame when the soul reaches the top */
const SOUL_UP = 26;
/** Frame when it starts being sucked back */
const SOUL_BACK = 48;
/** How high above the mouth it floats */
const SOUL_TOP = 20.0;

/** What a one-off animation adds on top of the plain standing pose */
interface ActState {
  frame: ClawdFrame;
  /** Text of the bubble over his head, if any */
  bubble: string;
  /** How high the whole body is lifted off the ground */
  lift: number;
  /** Height of the escaping soul, 0 when there is none */
  soul: number;
  soulT: number;
}

/**
 * One frame of a one-off animation. `t` is the frame index within the act.
 */
export function stepAct(act: string, t: number): ActState {
  const frame = makeFrame();
  const out: ActState = { frame, bubble: '', lift: 0, soul: 0, soulT: 0 };

  if (CLAWD_SEQS[act]) {
    // Claude Code animations - frame by frame, the pose itself sets the gaze.
    const fr = CLAWD_SEQS[act][Math.min(t, CLAWD_SEQS[act].length - 1)];
    Object.assign(frame, fr, { look: 0 });
    if (act === 'celebrate') out.bubble = '!';
    return out;
  }

  switch (act) {
    case 'wave':
      frame.look = 0; frame.eyes = 'happy';
      frame.arms = Math.floor(t / 4) % 2 ? 'down' : 'right';
      break;

    case 'stretch':
      if (t >= 4 && t < 18) { frame.arms = 'up'; frame.eyes = 'closed'; out.lift = 1.5; }
      break;

    case 'yawn':
      frame.look = 0;
      frame.eyes = t >= 3 && t < 17 ? 'yawn' : 'closed';
      break;

    case 'stumble':
      // Flops down (crouched, legs hidden), then gets up and stares, stunned.
      if (t < 12) { frame.off = 1; frame.eyes = 'closed'; } else { frame.eyes = 'wide'; }
      frame.look = 0;
      break;

    case 'soul':
      // Like in anime: the soul flies out of the open mouth on a thread, hangs over the body,
      // then gets sucked back in - and the body twitches.
      frame.flip = true; frame.look = 0;
      if (t < 6) {
        frame.eyes = 'x';
        frame.feet = t % 2 ? 'left' : 'right';
      } else if (t < SOUL_BACK + 6) {
        frame.eyes = 'gasp';
        out.soulT = t;
        if (t < SOUL_UP) {
          const k = (t - 6) / (SOUL_UP - 6);
          out.soul = SOUL_TOP * (1 - (1 - k) * (1 - k));        // floats out, slowing down
        } else if (t < SOUL_BACK) {
          out.soul = SOUL_TOP + 1.5 * Math.sin((t - SOUL_UP) / 2.5);
        } else {
          const k = (t - SOUL_BACK) / 6;
          out.soul = SOUL_TOP * (1 - k * k);                    // snaps back in
        }
      } else if (t < SOUL_BACK + 9) {
        frame.eyes = 'wide'; out.lift = 2.5;                    // wakes for a moment
      } else {
        frame.eyes = 'x';
      }
      break;

    case 'burrow':
      // Looks around, digs with his legs sinking into the sand, and closes his eyes.
      if (t < 4) {
        frame.look = t < 2 ? -1 : 1;
      } else if (t < 24) {
        frame.look = 0; frame.eyes = 'focus';
        frame.dig = Math.min(BURROW_DIG, Math.floor((t - 4) / 3.5));
        frame.feet = Math.floor(t / 2) % 2 ? 'left' : 'right';
        frame.arms = Math.floor(t / 2) % 2 ? 'up' : 'down';
        frame.spray = (t % 3) + 1;
      } else {
        frame.look = 0; frame.dig = BURROW_DIG;
        frame.eyes = t < 27 ? 'blink' : 'closed';
      }
      break;

    case 'unburrow':
      // Eyes wide, jumps out of the sand and shakes himself off.
      frame.look = 0;
      if (t < 3) {
        frame.dig = BURROW_DIG; frame.eyes = 'wide';
      } else if (t < 9) {
        frame.dig = Math.max(0, BURROW_DIG - (t - 3)); frame.eyes = 'wide';
        frame.arms = 'up'; frame.spray = (t % 3) + 1;
        if (t === 8) out.lift = 2;
      } else if (t < 21) {
        frame.eyes = 'closed';
        frame.look = Math.floor(t / 2) % 2 ? -1 : 1;
        frame.feet = Math.floor(t / 2) % 2 ? 'left' : 'right';
        if (t < 15) frame.spray = (t % 3) + 1;
      } else if (t < 23) {
        frame.eyes = 'blink';
      }
      break;

    case 'stir':
      // Rises in the burrow, looks around and sinks back into the sand.
      frame.dig = t < 15 ? BURROW_DIG - 1 : BURROW_DIG;
      if (t < 3) { frame.eyes = 'wide'; frame.look = 0; }
      else if (t < 13) { frame.look = t < 8 ? -1 : 1; }
      else if (t < 17) { frame.eyes = 'blink'; frame.look = 0; }
      else { frame.eyes = 'closed'; frame.look = 0; }
      break;
  }

  return out;
}

/**
 * Health by number of heart halves. Applies on top of any mood: walking speed, tired eyes,
 * yawns, sweat, swaying and stumbling. 0 - lies down.
 */
interface HealthTier {
  speed: number;
  hop?: number;
  yawn?: number;
  eyes?: string;
  sweat?: boolean;
  stagger?: boolean;
  stumble?: number;
}

export const HEALTH_TIERS: Record<number, HealthTier> = {
  6: { speed: 1.25, hop: 300 },
  5: { speed: 1.0 },
  4: { speed: 0.9, yawn: 350 },
  3: { speed: 0.75, yawn: 200, eyes: 'focus' },
  2: { speed: 0.55, yawn: 160, eyes: 'focus', sweat: true },
  1: { speed: 0.35, eyes: 'blink', sweat: true, stagger: true, stumble: 220 },
  0: { speed: 0.0 },
};

/**
 * Heart halves left of the 5-hour limit: 0..6, so each half is about 16.7% and zero hearts
 * happen only at 100%, exactly when Clawd lies down.
 */
export function heartHalves(sessionPercent: number | null): number | null {
  if (sessionPercent == null) return null;
  return Math.min(6, Math.max(0, Math.ceil(Math.max(0, 100 - sessionPercent) * 6 / 100)));
}
