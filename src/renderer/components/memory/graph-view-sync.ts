import type { LayoutRequest } from './graph-layout.worker';

/** How a graph view is turned, zoomed and panned */
export interface GraphView {
  /** Rotation of the layout (row-major 3x3) */
  rotation: number[];
  /** Zoom transform: translation and scale */
  x: number;
  y: number;
  k: number;
}

/**
 * Keeps graph views of the same graph moving as one (the simulation page's dark and light
 * previews): the view last touched leads, sharing how it is turned and zoomed every frame and
 * the nodes dragged in it; the others follow, with their own idle turning and fitting paused.
 */
export interface GraphViewSync {
  /** Add a view; the first one leads until another is touched. Returns how to remove it. */
  join(id: symbol, onLayoutRequest: (request: LayoutRequest) => void): () => void;
  /** The view was touched: it leads from now on */
  lead(id: symbol): void;
  isLeader(id: symbol): boolean;
  /** The leader's view, and how many times it has changed */
  readonly view: GraphView | null;
  readonly version: number;
  /** The leader shares its view */
  publish(id: symbol, view: GraphView): void;
  /** The leader dragged a node: the other views' layouts move it too */
  forward(id: symbol, request: LayoutRequest): void;
}

export function createGraphViewSync(): GraphViewSync {
  let leader: symbol | null = null;
  let view: GraphView | null = null;
  let version = 0;
  const members = new Map<symbol, (request: LayoutRequest) => void>();

  return {
    join(id, onLayoutRequest) {
      members.set(id, onLayoutRequest);
      if (!leader) leader = id;
      return () => {
        members.delete(id);
        if (leader === id) leader = members.keys().next().value ?? null;
      };
    },
    lead(id) {
      leader = id;
    },
    isLeader(id) {
      return leader === id;
    },
    get view() {
      return view;
    },
    get version() {
      return version;
    },
    publish(id, next) {
      if (leader !== id) return;
      view = { ...next, rotation: [...next.rotation] };
      version++;
    },
    forward(id, request) {
      if (leader !== id) return;
      for (const [member, onLayoutRequest] of members) {
        if (member !== id) onLayoutRequest(request);
      }
    },
  };
}
