import { describe, it, expect } from 'vitest';
import { generateRandomGraph, RANDOM_GRAPH_LIMITS } from './random-graph';

describe('generateRandomGraph', () => {
  it('has the asked number of nodes and distinct edges, none to itself', () => {
    const graph = generateRandomGraph(200, 400);
    expect(graph.nodes).toHaveLength(200);
    expect(graph.links).toHaveLength(400);
    const keys = new Set(graph.links.map((link) => [link.source, link.target].sort().join('|')));
    expect(keys.size).toBe(400);
    expect(graph.links.every((link) => link.source !== link.target)).toBe(true);
  });

  it('caps edges at what the nodes can have, and both counts at the limits', () => {
    expect(generateRandomGraph(5, 100).links).toHaveLength(10);
    const big = generateRandomGraph(RANDOM_GRAPH_LIMITS.nodes + 10, 0);
    expect(big.nodes).toHaveLength(RANDOM_GRAPH_LIMITS.nodes);
    expect(generateRandomGraph(0, 10)).toEqual({ nodes: [], links: [] });
  });

  it('puts the nodes in communities', () => {
    const communities = new Set(generateRandomGraph(240, 300).nodes.map((node) => node.community));
    expect(communities.size).toBeGreaterThan(1);
  });
});
