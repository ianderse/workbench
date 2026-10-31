/**
 * The glow around the node icons (the sub-agent and subtask icons, the main agent's face): their
 * color at half strength, so it lights the icon up without smudging it
 */
export function iconGlowColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}80` : color
}
