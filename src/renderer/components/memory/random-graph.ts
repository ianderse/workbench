import type { GraphifyGraph, GraphifyGraphNode } from '../../../shared/types/cli';

/** Most nodes and edges a generated graph gets (the graph view stays responsive up to here) */
export const RANDOM_GRAPH_LIMITS = { nodes: 5000, edges: 20000 } as const;

/** Share of edges that stay inside a community, so the communities show as clusters */
const IN_COMMUNITY_SHARE = 0.8;
/** Share of edges Graphify would have extracted from the code (the rest inferred, drawn fainter) */
const EXTRACTED_SHARE = 0.75;

const VERBS = ['load', 'parse', 'build', 'render', 'fetch', 'update', 'resolve', 'create', 'handle', 'format', 'read', 'write'];
const NOUNS = ['Settings', 'Task', 'Graph', 'Project', 'Session', 'Profile', 'Worktree', 'Terminal', 'Usage', 'Config', 'Agent', 'Event'];
const RELATIONS = ['calls', 'imports', 'contains'];

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

/** A name like the code entities Graphify finds ("parseSettings", "TaskStore.update") */
function codeName(index: number): string {
  const name = `${pick(VERBS)}${pick(NOUNS)}`;
  return index % 5 === 0 ? `${pick(NOUNS)}Store.${pick(VERBS)}` : name;
}

/**
 * A random graph shaped like Graphify's: `nodeCount` nodes in communities (about one per two
 * dozen nodes), and `edgeCount` distinct edges, most inside a community, most extracted. Counts
 * are capped at RANDOM_GRAPH_LIMITS, and edges at what that many nodes can have.
 */
export function generateRandomGraph(nodeCount: number, edgeCount: number): GraphifyGraph {
  const n = Math.max(0, Math.min(RANDOM_GRAPH_LIMITS.nodes, Math.floor(nodeCount)));
  const maxEdges = (n * (n - 1)) / 2;
  const m = Math.max(0, Math.min(RANDOM_GRAPH_LIMITS.edges, maxEdges, Math.floor(edgeCount)));

  const communities = Math.max(1, Math.round(n / 24));
  const members: number[][] = Array.from({ length: communities }, () => []);
  const nodes: GraphifyGraphNode[] = Array.from({ length: n }, (_, i) => {
    const community = Math.floor(Math.random() * communities);
    members[community].push(i);
    return { id: `node-${i}`, label: codeName(i), community };
  });

  const links: GraphifyGraph['links'] = [];
  const taken = new Set<string>();
  // Random picks can repeat; past this many tries the graph is as full as it is going to get
  for (let tries = 0; links.length < m && tries < m * 20 + 100; tries++) {
    const source = Math.floor(Math.random() * n);
    const own = members[nodes[source].community!];
    const target = Math.random() < IN_COMMUNITY_SHARE && own.length > 1 ? pick(own) : Math.floor(Math.random() * n);
    if (source === target) continue;
    const key = source < target ? `${source}-${target}` : `${target}-${source}`;
    if (taken.has(key)) continue;
    taken.add(key);
    links.push({
      source: nodes[source].id,
      target: nodes[target].id,
      relation: pick(RELATIONS),
      confidence: Math.random() < EXTRACTED_SHARE ? 'EXTRACTED' : 'INFERRED',
    });
  }
  return { nodes, links };
}
