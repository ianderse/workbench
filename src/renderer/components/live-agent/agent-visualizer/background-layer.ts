import { DepthParticle } from '../lib/agent-types'
import { COLORS } from '../lib/colors'
import { alphaHex } from '../lib/utils'

const NUM_PARTICLES = 80

export function createDepthParticles(width: number, height: number): DepthParticle[] {
  const particles: DepthParticle[] = []
  for (let i = 0; i < NUM_PARTICLES; i++) {
    particles.push({
      x: Math.random() * width * 2 - width * 0.5,
      y: Math.random() * height * 2 - height * 0.5,
      size: Math.random() * 1.5 + 0.5,
      brightness: Math.random() * 0.3 + 0.05,
      speed: Math.random() * 0.15 + 0.05,
      depth: Math.random(),
    })
  }
  return particles
}

export function updateDepthParticles(
  particles: DepthParticle[],
  deltaTime: number,
  width: number,
  height: number,
): void {
  for (const p of particles) {
    p.x += p.speed * deltaTime * 10 * (1 - p.depth * 0.5)
    p.y -= p.speed * deltaTime * 5 * (1 - p.depth * 0.3)

    // Wrap around
    if (p.x > width * 1.5) p.x = -width * 0.5
    if (p.y < -height * 0.5) p.y = height * 1.5
  }
}

export function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  particles: DepthParticle[],
  transform: { x: number; y: number; scale: number },
  activeAgentPos?: { x: number; y: number; color: string },
): void {
  // The background is the agent window's (bg-sidebar): nothing to fill

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

  // Depth particles (parallax)
  for (const p of particles) {
    const parallaxFactor = 0.3 + p.depth * 0.7
    const px = p.x + transform.x * parallaxFactor * 0.1
    const py = p.y + transform.y * parallaxFactor * 0.1
    const size = p.size * (0.5 + p.depth * 0.5)
    const alpha = p.brightness * (0.5 + p.depth * 0.5)

    ctx.beginPath()
    ctx.fillStyle = COLORS.holoBase + alphaHex(alpha)
    ctx.arc(px, py, size, 0, Math.PI * 2)
    ctx.fill()
  }

}
