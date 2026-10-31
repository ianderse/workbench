/**
 * The Graphify graph simulator (Settings > Simulation, development builds only): a random graph
 * of a chosen size, shown plain or colorful by the previews there. Kept in memory only.
 */

import { create } from 'zustand';
import type { GraphifyGraph } from '../../shared/types/cli';
import { generateRandomGraph } from '../components/memory/random-graph';

const DEFAULT_NODES = 150;
const DEFAULT_EDGES = 300;

interface GraphifySimulatorState {
  /** How many nodes and edges the next generated graph gets */
  nodes: number;
  edges: number;
  setNodes: (nodes: number) => void;
  setEdges: (edges: number) => void;
  /** The graph the previews show */
  graph: GraphifyGraph;
  /** Make a new random graph of the chosen size */
  generate: () => void;
  /** Colored by community instead of plain */
  colorful: boolean;
  setColorful: (colorful: boolean) => void;
}

export const useGraphifySimulatorStore = create<GraphifySimulatorState>((set, get) => ({
  nodes: DEFAULT_NODES,
  edges: DEFAULT_EDGES,
  setNodes: (nodes) => set({ nodes: Number.isFinite(nodes) ? Math.max(0, Math.floor(nodes)) : 0 }),
  setEdges: (edges) => set({ edges: Number.isFinite(edges) ? Math.max(0, Math.floor(edges)) : 0 }),
  graph: generateRandomGraph(DEFAULT_NODES, DEFAULT_EDGES),
  generate: () => set({ graph: generateRandomGraph(get().nodes, get().edges) }),
  colorful: false,
  setColorful: (colorful) => set({ colorful }),
}));
