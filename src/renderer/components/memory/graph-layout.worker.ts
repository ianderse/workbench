/**
 * 3D force layout for the memory graph view, run off the main thread (like Obsidian's graph worker).
 *
 * Receives the node count and links, lays them out in 3D with d3-force-3d and posts the node
 * positions as a Float32Array [x0, y0, z0, x1, y1, z1, ...] in node order on every tick. The view
 * rotates the result like a globe. Dragging pins a node to the pointer and reheats the simulation.
 */

import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type Simulation,
  type SimulationNode,
} from 'd3-force-3d';

export type LayoutRequest =
  | { type: 'init'; count: number; links: Array<[number, number]> }
  | { type: 'drag'; index: number; x: number; y: number; z: number }
  | { type: 'release'; index: number }
  | { type: 'stop' };

export type LayoutMessage = { type: 'positions'; positions: Float32Array; settled: boolean };

/**
 * Ticks run before the first frame (so the graph opens roughly laid out instead of as a blob),
 * within a time budget so large graphs still show up quickly
 */
const WARMUP_TICKS = 60;
const WARMUP_BUDGET_MS = 1500;

let simulation: Simulation<SimulationNode> | null = null;
let nodes: SimulationNode[] = [];

function postPositions(settled: boolean) {
  const positions = new Float32Array(nodes.length * 3);
  nodes.forEach((node, i) => {
    positions[i * 3] = node.x ?? 0;
    positions[i * 3 + 1] = node.y ?? 0;
    positions[i * 3 + 2] = node.z ?? 0;
  });
  const message: LayoutMessage = { type: 'positions', positions, settled };
  (self as unknown as Worker).postMessage(message, [positions.buffer]);
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const request = event.data;
  switch (request.type) {
    case 'init': {
      simulation?.stop();
      nodes = Array.from({ length: request.count }, () => ({}));
      const links = request.links.map(([source, target]) => ({ source, target }));
      // No collision force: in 3D nodes rarely overlap, and it was the slowest force and made the
      // dense core jitter. A coarser Barnes-Hut approximation (theta) keeps each tick fast.
      simulation = forceSimulation(nodes, 3)
        .force('link', forceLink(links).distance(30).strength(0.5))
        .force('charge', forceManyBody().strength(-60).theta(1.5).distanceMax(500))
        .force('center', forceCenter(0, 0, 0).strength(0.05))
        // Gravity toward the center keeps small disconnected groups from drifting off
        .force('x', forceX(0).strength(0.02))
        .force('y', forceY(0).strength(0.02))
        .force('z', forceZ(0).strength(0.02))
        .alphaDecay(0.05)
        .velocityDecay(0.6)
        .stop();
      const started = performance.now();
      for (let i = 0; i < WARMUP_TICKS && performance.now() - started < WARMUP_BUDGET_MS; i++) simulation.tick();
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
      node.fz = request.z;
      simulation.alphaTarget(0.3).restart();
      break;
    }
    case 'release': {
      const node = nodes[request.index];
      if (!node || !simulation) return;
      node.fx = null;
      node.fy = null;
      node.fz = null;
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
