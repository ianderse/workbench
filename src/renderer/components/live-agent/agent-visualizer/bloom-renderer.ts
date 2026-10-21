/**
 * Bloom post-processing for holographic glow effect.
 * Takes the main canvas at half resolution, blurs it, and composites it back
 * with additive blending (the dark background adds next to nothing).
 */

/** The bloom over each surface: full against a dark window, turned down over a
 *  light one, where the additive glow would only wash the nodes out and leave
 *  them with a halo of their own */
export const BLOOM_INTENSITY = { dark: 0.5, light: 0.1 } as const

export class BloomRenderer {
  private bloomCanvas: HTMLCanvasElement
  private bloomCtx: CanvasRenderingContext2D
  private tempCanvas: HTMLCanvasElement
  private tempCtx: CanvasRenderingContext2D
  private intensity: number

  private enabled: boolean

  constructor(intensity: number) {
    this.intensity = intensity
    this.bloomCanvas = document.createElement('canvas')
    this.tempCanvas = document.createElement('canvas')
    const bCtx = this.bloomCanvas.getContext('2d')
    const tCtx = this.tempCanvas.getContext('2d')
    this.enabled = !!(bCtx && tCtx)
    this.bloomCtx = bCtx!
    this.tempCtx = tCtx!
  }

  /** Follow the app's light/dark mode */
  setIntensity(intensity: number): void {
    this.intensity = intensity
  }

  /** Size to the main canvas's pixel size */
  resize(width: number, height: number): void {
    // Bloom at half resolution for performance
    const scale = 0.5
    this.bloomCanvas.width = Math.round(width * scale)
    this.bloomCanvas.height = Math.round(height * scale)
    this.tempCanvas.width = this.bloomCanvas.width
    this.tempCanvas.height = this.bloomCanvas.height
  }

  apply(sourceCanvas: HTMLCanvasElement, targetCtx: CanvasRenderingContext2D): void {
    const w = this.bloomCanvas.width
    const h = this.bloomCanvas.height

    if (w === 0 || h === 0 || !this.enabled) return

    // Draw source at half resolution
    this.bloomCtx.clearRect(0, 0, w, h)
    this.bloomCtx.drawImage(sourceCanvas, 0, 0, w, h)

    // Blur passes of decreasing radius
    this.blur(this.bloomCtx, this.tempCtx, w, h, 8)
    this.blur(this.bloomCtx, this.tempCtx, w, h, 6)
    this.blur(this.bloomCtx, this.tempCtx, w, h, 4)

    // Composite bloom over the target with additive blending
    targetCtx.save()
    targetCtx.setTransform(1, 0, 0, 1, 0, 0) // both canvases are in device pixels
    targetCtx.globalCompositeOperation = 'lighter'
    targetCtx.globalAlpha = this.intensity
    targetCtx.drawImage(this.bloomCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height)
    targetCtx.restore()
  }

  /** Gaussian blur through the canvas `blur()` filter */
  private blur(
    srcCtx: CanvasRenderingContext2D,
    tmpCtx: CanvasRenderingContext2D,
    w: number,
    h: number,
    radius: number,
  ): void {
    tmpCtx.clearRect(0, 0, w, h)
    tmpCtx.filter = `blur(${radius}px)`
    tmpCtx.drawImage(srcCtx.canvas, 0, 0)
    tmpCtx.filter = 'none'

    srcCtx.clearRect(0, 0, w, h)
    srcCtx.drawImage(tmpCtx.canvas, 0, 0)
  }
}
