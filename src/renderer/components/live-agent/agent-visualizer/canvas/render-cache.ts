// ─── Glow sprite cache ─────────────────────────────────────────────────────
// Pre-renders radial gradient glows to off-screen canvases.
// Avoids creating CanvasGradient objects every frame.

const glowSpriteCache = new Map<string, HTMLCanvasElement>()

/** Sprites kept, the least recently drawn going first. A node's glow takes a handful (its color,
 *  size and state alpha), but the main agent's color is eased as it wakes up and passes through a
 *  new color every frame of it: without a bound every wake would leave a hundred or so behind */
const MAX_GLOW_SPRITES = 256

/** Agent glow: gradient from innerRadius to outerRadius */
export function getAgentGlowSprite(
  color: string, innerRadius: number, outerRadius: number, glowAlphaHex: string,
): HTMLCanvasElement {
  const iR = Math.round(innerRadius)
  const oR = Math.ceil(outerRadius)
  const key = `ag|${color}|${iR}|${oR}|${glowAlphaHex}`
  let sprite = glowSpriteCache.get(key)
  if (sprite) {
    // Drawn again: to the back of the line, so the glows on screen are never the ones let go
    glowSpriteCache.delete(key)
    glowSpriteCache.set(key, sprite)
    return sprite
  }

  const size = oR * 2
  sprite = document.createElement('canvas')
  sprite.width = size
  sprite.height = size
  const ctx = sprite.getContext('2d')!
  const glow = ctx.createRadialGradient(oR, oR, iR, oR, oR, oR)
  glow.addColorStop(0, color + glowAlphaHex)
  glow.addColorStop(1, color + '00')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  glowSpriteCache.set(key, sprite)
  if (glowSpriteCache.size > MAX_GLOW_SPRITES) glowSpriteCache.delete(glowSpriteCache.keys().next().value!)
  return sprite
}
