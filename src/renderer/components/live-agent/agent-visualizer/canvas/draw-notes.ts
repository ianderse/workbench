import { WHISTLE, ZZZ } from '../../lib/canvas-constants'

/**
 * What comes off the main agent into the air: the sheet music it whistles when
 * it has been left alone long enough, and the Zs once it has fallen asleep
 * (see draw-face.ts). Either one leaves it and is on its own from then on: it
 * floats in world coordinates, rises, sways, turns and fades, so the node can
 * go back to work underneath while the last of them drift off.
 */
export interface WhistleNote {
  x: number
  y: number
  /** How fast it floats away (world units per second) */
  vx: number
  vy: number
  /** Which one it is, and which glyph of that kind: an eighth note, a
   *  sixteenth or a beamed pair for a note, nothing to choose for a Z */
  glyph: 'note' | 'z'
  kind: 0 | 1 | 2
  /** Half the glyph's height, in world units */
  size: number
  tilt: number
  /** How fast it turns (radians per second) */
  spin: number
  /** Sideways swing as it rises: how far, and where in the swing it starts */
  sway: number
  phase: number
  color: string
  age: number
  life: number
}

const rand = (base: number, jitter: number) => base + Math.random() * jitter
const signed = () => (Math.random() < 0.5 ? -1 : 1)

/** Whistle one note out of the mouth at (x, y), for a node of radius r; it
 *  drifts off the side the pucker points to (`drift`: +1 right) */
export function spawnNote(notes: WhistleNote[], x: number, y: number, r: number, drift: number, color: string) {
  if (notes.length >= WHISTLE.maxNotes) notes.shift()
  notes.push({
    glyph: 'note',
    x: x + (Math.random() - 0.5) * WHISTLE.mouthSpread * r,
    y,
    vx: drift * rand(WHISTLE.driftSpeed, WHISTLE.driftJitter),
    vy: -rand(WHISTLE.riseSpeed, WHISTLE.riseJitter),
    kind: Math.floor(Math.random() * 3) as 0 | 1 | 2,
    size: rand(WHISTLE.size, WHISTLE.sizeJitter) * r,
    tilt: signed() * Math.random() * WHISTLE.tilt,
    spin: signed() * Math.random() * WHISTLE.spin,
    sway: rand(WHISTLE.sway, WHISTLE.swayJitter),
    phase: Math.random() * Math.PI * 2,
    color,
    age: 0,
    life: rand(WHISTLE.life, WHISTLE.lifeJitter),
  })
}

/** One Z off a sleeping node of radius r at (x, y), the `step`th of the three
 *  sizes they climb through, drifting off the side it rises on (`drift`: +1
 *  right). They share the air with the notes: the same list, the same drift */
export function spawnZ(notes: WhistleNote[], x: number, y: number, r: number, step: number, drift: number, color: string) {
  if (notes.length >= WHISTLE.maxNotes) notes.shift()
  notes.push({
    glyph: 'z',
    kind: 0,
    x: x + (Math.random() - 0.5) * ZZZ.spread * r,
    y: y + (Math.random() - 0.5) * ZZZ.spread * r,
    vx: drift * rand(ZZZ.driftSpeed, ZZZ.driftJitter),
    vy: -rand(ZZZ.riseSpeed, ZZZ.riseJitter),
    size: ZZZ.sizes[step % ZZZ.sizes.length] * r,
    tilt: signed() * Math.random() * ZZZ.tilt,
    spin: signed() * Math.random() * ZZZ.spin,
    sway: rand(ZZZ.sway, ZZZ.swayJitter),
    phase: Math.random() * Math.PI * 2,
    color,
    age: 0,
    life: rand(ZZZ.life, ZZZ.lifeJitter),
  })
}

/** Float the notes along and drop the ones that have faded (in place, so a
 *  whistling face allocates nothing per frame) */
export function advanceNotes(notes: WhistleNote[], deltaTime: number) {
  let writeIdx = 0
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]
    note.age += deltaTime
    note.x += note.vx * deltaTime
    note.y += note.vy * deltaTime
    note.tilt += note.spin * deltaTime
    if (note.age < note.life) {
      if (writeIdx !== i) notes[writeIdx] = note
      writeIdx++
    }
  }
  notes.length = writeIdx
}

/** A note fades in as it leaves the mouth and out as it drifts off */
function noteAlpha(note: WhistleNote): number {
  const inK = Math.min(1, note.age / WHISTLE.fadeIn)
  const outK = Math.min(1, (note.life - note.age) / WHISTLE.fadeOut)
  return WHISTLE.alpha * inK * outK
}

/** One glyph, drawn around the origin in a box 2 units tall: a note head with
 *  a stem, flagged once (eighth), twice (sixteenth), or beamed to a second
 *  head (a pair). The caller has scaled the units to the note's size. */
function noteGlyph(ctx: CanvasRenderingContext2D, kind: 0 | 1 | 2) {
  const head = (hx: number) => {
    ctx.save()
    ctx.translate(hx, 0.6)
    ctx.rotate(-0.33)
    ctx.beginPath()
    ctx.ellipse(0, 0, 0.36, 0.25, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  const stem = (hx: number) => ctx.fillRect(hx + 0.26, -0.9, 0.11, 1.5)
  /** A flag off the top of the stem, curling down to the right */
  const flag = (dy: number) => {
    ctx.beginPath()
    ctx.moveTo(0.37, -0.9 + dy)
    ctx.quadraticCurveTo(0.95, -0.6 + dy, 0.66, -0.1 + dy)
    ctx.quadraticCurveTo(0.76, -0.52 + dy, 0.37, -0.6 + dy)
    ctx.closePath()
    ctx.fill()
  }

  if (kind === 2) {
    // A beamed pair: two heads under one beam
    head(-0.78)
    head(0.28)
    stem(-0.78)
    stem(0.28)
    ctx.fillRect(-0.52, -0.95, 1.18, 0.19)
    return
  }
  head(0)
  stem(0)
  flag(0)
  if (kind === 1) flag(0.34)
}

/** A Z, drawn around the origin in the same box the notes use: the two bars
 *  and the stroke between them, with the corners rounded off */
function zGlyph(ctx: CanvasRenderingContext2D) {
  ctx.lineWidth = ZZZ.weight
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-0.52, -0.62)
  ctx.lineTo(0.52, -0.62)
  ctx.lineTo(-0.52, 0.62)
  ctx.lineTo(0.52, 0.62)
  ctx.stroke()
}

/** Draw the notes in the air, dimmed by the node's own `opacity` */
export function drawNotes(ctx: CanvasRenderingContext2D, notes: readonly WhistleNote[], opacity: number) {
  for (const note of notes) {
    const alpha = noteAlpha(note) * opacity
    if (alpha < 0.01) continue
    ctx.save()
    ctx.globalAlpha *= alpha
    ctx.translate(note.x + Math.sin(note.age * WHISTLE.swaySpeed + note.phase) * note.sway, note.y)
    ctx.rotate(note.tilt)
    ctx.scale(note.size, note.size)
    ctx.fillStyle = note.color
    ctx.strokeStyle = note.color
    ctx.shadowColor = note.color
    // Pixels, whatever the glyph's size: a shadow's blur ignores the transform
    ctx.shadowBlur = WHISTLE.glowBlur
    if (note.glyph === 'z') zGlyph(ctx)
    else noteGlyph(ctx, note.kind)
    ctx.restore()
  }
}
