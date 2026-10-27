import { describe, it, expect } from 'vitest'
import { displayedColor, type FaceState } from '../draw-face'
import { getStateColor } from '../../../lib/colors'

/** A face as displayedColor reads it, last drawn in `state`'s color and showing `expression` */
function faceIn(state: Parameters<typeof getStateColor>[0], expression: string): Map<string, FaceState> {
  const n = parseInt(getStateColor(state).slice(1), 16)
  const face = {
    rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255],
    rgbTime: 0, colorEaseUntil: 0, colorEaseTo: '', expression,
  } as unknown as FaceState
  return new Map([['main', face]])
}

/** The face wakes on the frame work's color first arrives (drawFace, right after displayedColor) */
function wake(faces: Map<string, FaceState>, time: number): string {
  const color = displayedColor(faces, 'main', 'thinking', time)
  faces.get('main')!.expression = 'startled' as FaceState['expression']
  return color
}

describe('displayedColor', () => {
  it('eases the wake into work, in steps the glow cache can keep up with', () => {
    const faces = faceIn('idle', 'asleep')
    const seen = new Set<string>([wake(faces, 1 / 60)])
    for (let frame = 2; frame <= 120; frame++) seen.add(displayedColor(faces, 'main', 'thinking', frame / 60))
    expect(seen.has(getStateColor('thinking'))).toBe(false)
    // Far fewer colors than the 120 frames it took
    expect(seen.size).toBeLessThan(60)
    expect(displayedColor(faces, 'main', 'thinking', 3)).toBe(getStateColor('thinking'))
  })

  it('cuts to a change that comes along while the wake is still easing', () => {
    const faces = faceIn('idle', 'asleep')
    wake(faces, 0.1)
    expect(displayedColor(faces, 'main', 'thinking', 0.2)).not.toBe(getStateColor('thinking'))
    expect(displayedColor(faces, 'main', 'tool_calling', 0.3)).toBe(getStateColor('tool_calling'))
  })
})
