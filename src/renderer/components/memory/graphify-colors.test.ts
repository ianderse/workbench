import { describe, expect, it } from 'vitest';
import { communityColorIndex, GRAPHIFY_COMMUNITY_COLORS } from './graphify-colors';

describe('graphify colors', () => {
  it('uses Graphify\'s palette in order', () => {
    expect(GRAPHIFY_COMMUNITY_COLORS).toEqual([
      '#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
      '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
    ]);
  });

  it('maps communities to palette indexes like Graphify', () => {
    expect(communityColorIndex(undefined)).toBe(0);
    expect(communityColorIndex(3)).toBe(3);
    expect(communityColorIndex(13)).toBe(3);
    expect(communityColorIndex(-1)).toBe(9);
    expect(communityColorIndex(1.5)).toBe(0);
  });
});
