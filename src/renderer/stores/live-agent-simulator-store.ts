/**
 * The live agent simulator (Settings > Developer, development builds only): a graph the developer
 * builds by hand under the master node, shown by the live agent previews there. Kept in memory
 * only; both previews read the same tree.
 */

import { create } from 'zustand';

export type SimNodeKind = 'subtask' | 'subagent' | 'tool';

export interface SimNode {
  id: string;
  kind: SimNodeKind;
  /** The node it hangs off: MASTER_ID or a subtask or subagent */
  parentId: string;
  /** The number shown in its row ("Subagent 2"), counted per kind */
  n: number;
  /** A tool node's tool name */
  tool?: string;
}

/** The master node: the session's main agent, always there */
export const MASTER_ID = 'main';

/** What can be added under each node: a subtask is a whole session, a subagent only calls tools */
export const CHILD_KINDS: Record<'master' | 'subtask' | 'subagent', SimNodeKind[]> = {
  master: ['subtask', 'subagent', 'tool'],
  subtask: ['subagent', 'tool'],
  subagent: ['tool'],
};

/** Tool names given to new tool nodes in turn, so the graph shows a few different ones */
const TOOL_NAMES = ['Read', 'Grep', 'Edit', 'Bash', 'Glob', 'Write', 'WebSearch'];

interface LiveAgentSimulatorState {
  /** Every node, parents before their children (in the order they were added) */
  nodes: SimNode[];
  add: (parentId: string, kind: SimNodeKind) => void;
  /** Remove a node and everything under it */
  remove: (id: string) => void;
}

let nextId = 0;
const counts: Record<SimNodeKind, number> = { subtask: 0, subagent: 0, tool: 0 };

export const useLiveAgentSimulatorStore = create<LiveAgentSimulatorState>((set) => ({
  nodes: [],
  add: (parentId, kind) => set((state) => {
    const n = ++counts[kind];
    const node: SimNode = {
      id: `${kind}-${++nextId}`,
      kind,
      parentId,
      n,
      tool: kind === 'tool' ? TOOL_NAMES[(n - 1) % TOOL_NAMES.length] : undefined,
    };
    return { nodes: [...state.nodes, node] };
  }),
  remove: (id) => set((state) => {
    const gone = new Set([id]);
    // Parents come first, so one pass finds every descendant
    for (const node of state.nodes) {
      if (gone.has(node.parentId)) gone.add(node.id);
    }
    return { nodes: state.nodes.filter((node) => !gone.has(node.id)) };
  }),
}));
