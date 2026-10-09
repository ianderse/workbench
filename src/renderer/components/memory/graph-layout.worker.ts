/**
 * Force layout for the memory graph view, run off the main thread (like Obsidian's graph worker).
 *
 * Receives the nodes (with radii) and links, lays them out with d3-force and posts the node
 * positions as a Float32Array [x0, y0, x1, y1, ...] in node order on every tick. Dragging pins a
 * node to the pointer and reheats the simulation.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

interface LayoutNode extends SimulationNodeDatum {
  radius: number;
}

export type LayoutRequest =
  | { type: 'init'; radii: number[]; links: Array<[number, number]> }
  | { type: 'drag'; index: number; x: number; y: number }
  | { type: 'release'; index: number }
  | { type: 'stop' };

export type LayoutMessage = { type: 'positions'; positions: Float32Array; settled: boolean };

/** Ticks run before the first frame, so the graph opens roughly laid out instead of as a blob */
const WARMUP_TICKS = 60;

let simulation: Simulation<LayoutNode, SimulationLinkDatum<LayoutNode>> | null = null;
let nodes: LayoutNode[] = [];

function postPositions(settled: boolean) {
  const positions = new Float32Array(nodes.length * 2);
  nodes.forEach((node, i) => {
    positions[i * 2] = node.x ?? 0;
    positions[i * 2 + 1] = node.y ?? 0;
  });
  const message: LayoutMessage = { type: 'positions', positions, settled };
  (self as unknown as Worker).postMessage(message, [positions.buffer]);
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const request = event.data;
  switch (request.type) {
    case 'init': {
      simulation?.stop();
      nodes = request.radii.map((radius) => ({ radius }));
      const links = request.links.map(([source, target]) => ({ source, target }));
      simulation = forceSimulation<LayoutNode>(nodes)
        .force('link', forceLink<LayoutNode, SimulationLinkDatum<LayoutNode>>(links).distance(30).strength(0.5))
        .force('charge', forceManyBody<LayoutNode>().strength(-60).theta(0.9).distanceMax(500))
        .force('center', forceCenter(0, 0).strength(0.05))
        // Gravity toward the center keeps small disconnected groups from drifting off
        .force('x', forceX<LayoutNode>(0).strength(0.04))
        .force('y', forceY<LayoutNode>(0).strength(0.04))
        .force('collide', forceCollide<LayoutNode>((node) => node.radius + 2))
        .alphaDecay(0.035)
        .stop();
      simulation.tick(WARMUP_TICKS);
      postPositions(false);
      simulation
        .on('tick', () => postPositions(false))
        .on('end', () => postPositions(true))
        .restart();
      break;
    }
    case 'drag': {
      const node = nodes[request.index];
      if (!node || !simulation) return;
      node.fx = request.x;
      node.fy = request.y;
      simulation.alphaTarget(0.3).restart();
      break;
    }
    case 'release': {
      const node = nodes[request.index];
      if (!node || !simulation) return;
      node.fx = null;
      node.fy = null;
      simulation.alphaTarget(0);
      break;
    }
    case 'stop':
      simulation?.stop();
      simulation = null;
      nodes = [];
      break;
  }
};
