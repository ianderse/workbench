/** Graphify's community palette (graphify/exporters/base.py COMMUNITY_COLORS), so nodes match its graph.html */
export const GRAPHIFY_COMMUNITY_COLORS = [
  '#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
  '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
] as const;

/** Palette index of a community, like Graphify: no community counts as 0 */
export function communityColorIndex(community?: number): number {
  if (community === undefined || !Number.isInteger(community)) return 0;
  const n = GRAPHIFY_COMMUNITY_COLORS.length;
  return ((community % n) + n) % n;
}
