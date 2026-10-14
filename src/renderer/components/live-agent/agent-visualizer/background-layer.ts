/** The background: an ambient spotlight following the active agent (the page's
 *  own background shows everywhere else) */
export function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  transform: { x: number; y: number; scale: number },
  activeAgentPos?: { x: number; y: number; color: string },
): void {
  // Ambient spotlight following active agent
  if (activeAgentPos) {
    const screenX = activeAgentPos.x * transform.scale + transform.x
    const screenY = activeAgentPos.y * transform.scale + transform.y
    const gradient = ctx.createRadialGradient(screenX, screenY, 0, screenX, screenY, 300)
    gradient.addColorStop(0, activeAgentPos.color + '08')
    gradient.addColorStop(1, 'transparent')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
  }
}
