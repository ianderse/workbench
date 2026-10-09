import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
// The app's Content Security Policy forbids eval; this makes PixiJS build its shaders without it
import 'pixi.js/unsafe-eval';
import { Application, Circle, Color, Container, Graphics, Text } from 'pixi.js';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { useMemoryGraphStore } from '../../stores/memory-graph-store';
import type { GraphifyGraph, GraphifyGraphNode } from '../../../shared/types/cli';
import type { LayoutMessage, LayoutRequest } from './graph-layout.worker';

interface ViewNode extends GraphifyGraphNode {
  index: number;
  radius: number;
  connections: number;
}

/** Zoom level from which labels show (below it only the hovered neighbourhood's do) */
const LABEL_ZOOM = 1.2;
/** At most this many labels at once, so zooming in on a dense area stays smooth */
const MAX_LABELS = 300;
/** Screen-space cells a label occupies, so labels don't overlap */
const LABEL_CELL = { w: 24, h: 16 };
/** Camera distance from the graph's center, in graph radii (smaller exaggerates perspective) */
const CAMERA_DISTANCE = 3;
/** How fast a released spin slows down (ms for it to drop to about a third) */
const SPIN_DECAY_MS = 300;

/**
 * Soft colors for the most connected nodes after the master node (which uses the primary color).
 * The top 1 + GROUP_COLORS.length nodes are group heads: adding a color colors one more group.
 */
const GROUP_COLORS = [
  '#6A9BCC', // blue
  '#7FB77E', // sage
  '#C9A0DC', // lavender
  '#E0B65A', // mustard
  '#5FB3B3', // teal
  '#D98BA6', // rose
  '#9D8FD1', // periwinkle
  '#B5C46B', // olive
  '#D4A373', // tan
  '#7AA6A0', // sea green
  '#C77D9E', // mauve
  '#8FB5D9', // sky
  '#B39C7D', // taupe
  '#A3C9A8', // mint
  '#E2A0A0', // salmon
  '#A7B4C2', // slate
];

/** Theme colors from the page's CSS, re-read when the appearance changes */
function readColors() {
  const body = getComputedStyle(document.body);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || body.color;
  return {
    node: new Color(body.color),
    accent: new Color(accent),
    link: new Color(body.color),
    text: new Color(body.color),
    font: body.fontFamily,
  };
}

/** "." -> ".." -> "..." in a fixed width, so the text before it doesn't move */
function LoadingDots() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const timer = setInterval(() => setCount((current) => (current % 3) + 1), 400);
    return () => clearInterval(timer);
  }, []);
  return <span className="inline-block w-[3ch] text-left">{'.'.repeat(count)}</span>;
}

/**
 * Obsidian-style graph view of the project's memory graph (Graphify's graph.json). Like Obsidian,
 * the force layout runs in a Web Worker (in 3D, with d3-force-3d) and PixiJS draws the graph with
 * WebGL. Drag the background to turn the graph like a globe (it keeps spinning when flicked), wheel
 * to zoom, Shift+drag to pan, drag nodes to move them and hover to highlight a node's neighbours.
 */
export function MemoryGraph({ projectId }: { projectId: string }) {
  const { t } = useTranslation('navigation');
  const containerRef = useRef<HTMLDivElement>(null);
  const revision = useMemoryGraphStore((state) => state.revision[projectId] ?? 0);
  const [graph, setGraph] = useState<GraphifyGraph | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  // False until the first layout of the loaded graph is drawn
  const [laidOut, setLaidOut] = useState(false);

  // Load the graph (again after a rebuild)
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    window.electronAPI.getGraphifyGraph(projectId).then((result) => {
      if (cancelled) return;
      if (!result.success) {
        setStatus('error');
      } else if (!result.data || result.data.nodes.length === 0) {
        setStatus('empty');
      } else {
        setGraph(result.data);
        setStatus('ready');
      }
    }).catch(() => {
      if (!cancelled) setStatus('error');
    });
    return () => { cancelled = true; };
  }, [projectId, revision]);

  // Lay it out and draw it
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !graph || status !== 'ready') return;

    setLaidOut(false);
    let disposed = false;
    let app: Application | null = null;
    let zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown> | null = null;
    let themeObserver: MutationObserver | null = null;
    const worker = new Worker(new URL('./graph-layout.worker.ts', import.meta.url), { type: 'module' });
    const send = (request: LayoutRequest) => worker.postMessage(request);

    // Graph data: sizes by number of connections
    const indexById = new Map(graph.nodes.map((node, i) => [node.id, i]));
    const neighbours: Array<Set<number>> = graph.nodes.map(() => new Set());
    const linkPairs: Array<[number, number]> = [];
    for (const link of graph.links) {
      const source = indexById.get(link.source);
      const target = indexById.get(link.target);
      if (source === undefined || target === undefined) continue;
      linkPairs.push([source, target]);
      neighbours[source].add(target);
      neighbours[target].add(source);
    }
    const nodes: ViewNode[] = graph.nodes.map((node, index) => {
      const connections = neighbours[index].size;
      return { ...node, index, connections, radius: Math.min(2.5 + Math.sqrt(connections) * 1.1, 16) };
    });
    // Layout positions from the worker [x, y, z, ...], and their projection on screen (world
    // container coordinates), depth (positive toward the viewer) and perspective scale
    let positions: Float32Array<ArrayBufferLike> = new Float32Array(nodes.length * 3);
    const projectedX = new Float32Array(nodes.length);
    const projectedY = new Float32Array(nodes.length);
    const depth = new Float32Array(nodes.length);
    const perspective = new Float32Array(nodes.length).fill(1);
    let graphRadius = 1;
    // Rotation applied to the layout (row-major 3x3), changed by dragging the background
    let rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const byConnections = [...nodes].sort((a, b) => b.connections - a.connections);

    // Groups: the most connected nodes are group heads (rank 0 is the master node); a node takes
    // the group of the head it links to (the least connected one when it links to several), and a
    // link takes the group of its head end (the parent's when both ends are heads)
    const headRank = new Map<number, number>();
    byConnections.slice(0, 1 + GROUP_COLORS.length).forEach((node, rank) => {
      if (node.connections > 0) headRank.set(node.index, rank);
    });
    const groupOf = new Int16Array(nodes.length).fill(-1);
    for (const node of nodes) {
      const own = headRank.get(node.index);
      if (own !== undefined) {
        groupOf[node.index] = own;
        continue;
      }
      for (const neighbour of neighbours[node.index]) {
        const rank = headRank.get(neighbour);
        if (rank !== undefined && rank > groupOf[node.index]) groupOf[node.index] = rank;
      }
    }
    // Links bucketed by group (index 0 holds the ungrouped ones, group g is at g + 1)
    const linksByGroup: Array<Array<[number, number]>> = Array.from({ length: headRank.size + 2 }, () => []);
    for (const pair of linkPairs) {
      const a = headRank.get(pair[0]);
      const b = headRank.get(pair[1]);
      const group = a !== undefined && b !== undefined ? Math.min(a, b) : a ?? b ?? -1;
      linksByGroup[group + 1].push(pair);
    }
    let dirty = false;

    const setup = async () => {
      const pixi = new Application();
      await pixi.init({
        resizeTo: container,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      });
      if (disposed) {
        pixi.destroy(true, { children: true });
        return;
      }
      app = pixi;
      container.appendChild(pixi.canvas);
      pixi.canvas.style.display = 'block';

      // Scene: a world container (zoomed and panned) with links under nodes under labels
      const world = new Container();
      const linkLayer = new Graphics();
      const nodeLayer = new Container();
      // Nodes nearer the viewer draw (and take the pointer) over those behind them
      nodeLayer.sortableChildren = true;
      const labelLayer = new Container();
      world.addChild(linkLayer, nodeLayer, labelLayer);
      // Hidden until the first layout arrives and is fitted
      world.visible = false;
      pixi.stage.addChild(world);

      let colors = readColors();
      let hovered: ViewNode | null = null;
      let dragged: ViewNode | null = null;
      let dragMoved = false;
      let transform: ZoomTransform = zoomIdentity;
      let userMoved = false;
      const nodeGraphics: Graphics[] = [];
      const labels = new Map<number, Text>();

      const groupPalette = GROUP_COLORS.map((color) => new Color(color));
      const groupColor = (group: number) => (group === 0 ? colors.accent : groupPalette[group - 1]);
      // A hovered node and its links light up in its group's color (the primary color without one)
      const highlightColor = (node: ViewNode) => groupColor(Math.max(groupOf[node.index], 0));
      const drawNode = (node: ViewNode) => {
        const g = nodeGraphics[node.index].clear();
        const group = groupOf[node.index];
        if (hovered?.index === node.index) {
          g.circle(0, 0, node.radius).fill({ color: highlightColor(node), alpha: 1 });
          return;
        }
        if (group < 0) {
          g.circle(0, 0, node.radius).fill({ color: colors.node, alpha: 0.75 });
        } else {
          g.circle(0, 0, node.radius).fill({ color: groupColor(group), alpha: headRank.has(node.index) ? 1 : 0.85 });
        }
      };

      for (const node of nodes) {
        const g = new Graphics();
        g.eventMode = 'static';
        g.cursor = 'pointer';
        g.hitArea = new Circle(0, 0, node.radius + 3);
        g.on('pointerover', () => { if (!dragged) setHovered(node); });
        g.on('pointerout', () => { if (!dragged) setHovered(null); });
        g.on('pointerdown', (event) => {
          event.stopPropagation();
          spin = null;
          dragged = node;
          dragMoved = false;
        });
        nodeGraphics.push(g);
        nodeLayer.addChild(g);
        drawNode(node);
      }

      const inFocus = (index: number) =>
        !hovered || hovered.index === index || neighbours[hovered.index].has(index);

      const labelFor = (node: ViewNode) => {
        let label = labels.get(node.index);
        if (!label) {
          label = new Text({
            text: node.label,
            style: { fontFamily: colors.font, fontSize: 11, fill: colors.text },
            resolution: 2,
          });
          label.anchor.set(0.5, 0);
          label.alpha = 0.8;
          label.eventMode = 'none';
          labels.set(node.index, label);
          labelLayer.addChild(label);
        }
        return label;
      };

      // Labels for nodes on screen when zoomed in, or for the hovered neighbourhood
      const updateLabels = () => {
        const k = transform.k;
        const left = -transform.x / k;
        const top = -transform.y / k;
        const right = left + pixi.screen.width / k;
        const bottom = top + pixi.screen.height / k;
        const show = new Set<number>();
        if (hovered) {
          show.add(hovered.index);
          for (const index of neighbours[hovered.index]) show.add(index);
        } else if (k >= LABEL_ZOOM) {
          // Most-connected nodes first; skip a label where one is already drawn (screen-space grid)
          const taken = new Set<string>();
          for (const node of byConnections) {
            if (show.size >= MAX_LABELS) break;
            // Only the half facing the viewer
            if (depth[node.index] < 0) continue;
            const x = projectedX[node.index];
            const y = projectedY[node.index];
            if (x < left || x > right || y < top || y > bottom) continue;
            const screenX = x * k + transform.x;
            const screenY = y * k + transform.y;
            const halfWidth = Math.min(node.label.length * 3.2, 120);
            const cells: string[] = [];
            for (let cx = Math.floor((screenX - halfWidth) / LABEL_CELL.w); cx <= Math.floor((screenX + halfWidth) / LABEL_CELL.w); cx++) {
              cells.push(`${cx}:${Math.floor(screenY / LABEL_CELL.h)}`);
            }
            if (cells.some((cell) => taken.has(cell))) continue;
            for (const cell of cells) taken.add(cell);
            show.add(node.index);
          }
        }
        for (const [index, label] of labels) {
          if (!show.has(index)) label.visible = false;
        }
        for (const index of show) {
          const node = nodes[index];
          const label = labelFor(node);
          label.visible = true;
          label.scale.set(1 / Math.max(k, 1));
          const nodeScale = (k > 1 ? 1 / Math.sqrt(k) : 1) * perspective[index];
          label.position.set(projectedX[index], projectedY[index] + node.radius * nodeScale + 2 / Math.max(k, 1));
        }
      };

      const drawLinks = () => {
        linkLayer.clear();
        const width = 1 / transform.k;
        if (hovered) {
          // Dim every link, then draw the hovered node's links on top
          for (const [s, t] of linkPairs) {
            linkLayer.moveTo(projectedX[s], projectedY[s]).lineTo(projectedX[t], projectedY[t]);
          }
          linkLayer.stroke({ width, color: colors.link, alpha: 0.04 });
          for (const [s, t] of linkPairs) {
            if (s !== hovered.index && t !== hovered.index) continue;
            linkLayer.moveTo(projectedX[s], projectedY[s]).lineTo(projectedX[t], projectedY[t]);
          }
          linkLayer.stroke({ width: width * 1.5, color: highlightColor(hovered), alpha: 0.9 });
        } else {
          linksByGroup.forEach((pairs, bucket) => {
            if (pairs.length === 0) return;
            for (const [s, t] of pairs) {
              linkLayer.moveTo(projectedX[s], projectedY[s]).lineTo(projectedX[t], projectedY[t]);
            }
            linkLayer.stroke(bucket === 0
              ? { width, color: colors.link, alpha: 0.12 }
              : { width, color: groupColor(bucket - 1), alpha: 0.35 });
          });
        }
      };

      // Rotate the layout and project it with perspective
      const project = () => {
        const [a, b, c, d, e, f, g, h, i] = rotation;
        const camera = graphRadius * CAMERA_DISTANCE;
        for (let n = 0; n < nodes.length; n++) {
          const x = positions[n * 3], y = positions[n * 3 + 1], z = positions[n * 3 + 2];
          const rx = a * x + b * y + c * z;
          const ry = d * x + e * y + f * z;
          const rz = g * x + h * y + i * z;
          const scale = camera / Math.max(camera - rz, camera * 0.1);
          projectedX[n] = rx * scale;
          projectedY[n] = ry * scale;
          depth[n] = rz;
          perspective[n] = scale;
        }
      };

      const render = () => {
        project();
        // Zoomed in, nodes grow slower than the distances between them (like Obsidian)
        const nodeScale = transform.k > 1 ? 1 / Math.sqrt(transform.k) : 1;
        for (const node of nodes) {
          const g = nodeGraphics[node.index];
          g.position.set(projectedX[node.index], projectedY[node.index]);
          g.scale.set(nodeScale * perspective[node.index]);
          g.zIndex = depth[node.index];
          // Fade the far side of the globe
          const nearness = Math.min(Math.max((depth[node.index] + graphRadius) / (2 * graphRadius), 0), 1);
          g.alpha = (inFocus(node.index) ? 1 : 0.15) * (0.25 + 0.75 * nearness);
        }
        drawLinks();
        updateLabels();
      };

      function setHovered(node: ViewNode | null) {
        const previous = hovered;
        hovered = node;
        if (previous) drawNode(previous);
        if (node) drawNode(node);
        dirty = true;
      }

      // Zoom with the wheel and pan with Shift+drag through d3-zoom (dragging turns the graph)
      const canvas = pixi.canvas as HTMLCanvasElement;
      zoomBehavior = zoom<HTMLCanvasElement, unknown>()
        .scaleExtent([0.02, 8])
        .filter((event: MouseEvent) =>
          !dragged && (event.type === 'wheel' || (event.type === 'mousedown' && event.shiftKey && !hovered)))
        .on('zoom', (event) => {
          if (event.sourceEvent) userMoved = true;
          transform = event.transform;
          world.position.set(transform.x, transform.y);
          world.scale.set(transform.k);
          dirty = true;
        });
      const canvasSelection = select<HTMLCanvasElement, unknown>(canvas);
      canvasSelection.call(zoomBehavior).on('dblclick.zoom', null);

      // Center the graph and zoom so it fills the page
      const fitToView = () => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < nodes.length; i++) {
          const x = projectedX[i], y = projectedY[i], r = nodes[i].radius * perspective[i];
          minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
          minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
        }
        const k = Math.min(pixi.screen.width / Math.max(maxX - minX, 1), pixi.screen.height / Math.max(maxY - minY, 1), 2) * 0.97;
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        canvasSelection.call(
          zoomBehavior!.transform,
          zoomIdentity.translate(pixi.screen.width / 2 - cx * k, pixi.screen.height / 2 - cy * k).scale(k)
        );
      };

      worker.onmessage = (event: MessageEvent<LayoutMessage>) => {
        positions = event.data.positions;
        graphRadius = 1;
        for (let i = 0; i < nodes.length; i++) {
          graphRadius = Math.max(graphRadius, Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
        }
        // Keep the graph in view while it spreads out, until the user zooms or pans
        if (!userMoved) {
          project();
          fitToView();
        }
        if (!world.visible) {
          world.visible = true;
          setLaidOut(true);
        }
        dirty = true;
      };
      send({ type: 'init', count: nodes.length, links: linkPairs });

      // Turning the graph like a globe: the surface follows the pointer, and a flick keeps spinning
      let rotating = false;
      let lastPointer = { x: 0, y: 0, time: 0 };
      let velocity = { x: 0, y: 0 };
      let spin: { x: number; y: number } | null = null;
      const rotateBy = (dx: number, dy: number) => {
        const length = Math.hypot(dx, dy);
        if (length === 0) return;
        // Turn around the on-screen axis perpendicular to the drag (Rodrigues' formula)
        const angle = length / (transform.k * graphRadius);
        const ux = -dy / length;
        const uy = dx / length;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const t = 1 - cos;
        const turn = [
          t * ux * ux + cos, t * ux * uy, uy * sin,
          t * ux * uy, t * uy * uy + cos, -ux * sin,
          -uy * sin, ux * sin, cos,
        ];
        const next = new Array<number>(9);
        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 3; col++) {
            next[row * 3 + col] = turn[row * 3] * rotation[col] + turn[row * 3 + 1] * rotation[3 + col] + turn[row * 3 + 2] * rotation[6 + col];
          }
        }
        rotation = next;
        dirty = true;
      };
      const cursorStyles = pixi.renderer.events.cursorStyles;
      cursorStyles.default = 'grab';
      canvas.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.shiftKey || dragged || hovered) return;
        rotating = true;
        spin = null;
        velocity = { x: 0, y: 0 };
        lastPointer = { x: event.clientX, y: event.clientY, time: performance.now() };
        canvas.setPointerCapture(event.pointerId);
        cursorStyles.default = 'grabbing';
        canvas.style.cursor = 'grabbing';
      });
      canvas.addEventListener('pointermove', (event) => {
        if (!rotating) return;
        const now = performance.now();
        const dx = event.clientX - lastPointer.x;
        const dy = event.clientY - lastPointer.y;
        // Browsers can send a move without movement right before the release; it isn't a stop
        if (dx === 0 && dy === 0) return;
        const elapsed = Math.max(now - lastPointer.time, 1);
        // Smoothed, so one uneven move doesn't decide the spin
        velocity = { x: velocity.x * 0.5 + (dx / elapsed) * 0.5, y: velocity.y * 0.5 + (dy / elapsed) * 0.5 };
        lastPointer = { x: event.clientX, y: event.clientY, time: now };
        rotateBy(dx, dy);
      });
      const endRotate = (event: PointerEvent) => {
        if (!rotating) return;
        rotating = false;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        cursorStyles.default = 'grab';
        canvas.style.cursor = 'grab';
        // Keep spinning when released mid-flick
        if (performance.now() - lastPointer.time < 100 && Math.hypot(velocity.x, velocity.y) > 0.05) spin = velocity;
      };
      canvas.addEventListener('pointerup', endRotate);
      canvas.addEventListener('pointercancel', endRotate);

      // Draw at most once per frame, only when something changed
      pixi.ticker.add((ticker) => {
        if (spin) {
          rotateBy(spin.x * ticker.deltaMS, spin.y * ticker.deltaMS);
          const decay = Math.exp(-ticker.deltaMS / SPIN_DECAY_MS);
          spin = { x: spin.x * decay, y: spin.y * decay };
          if (Math.hypot(spin.x, spin.y) < 0.01) spin = null;
        }
        if (!dirty) return;
        dirty = false;
        render();
      });

      // Dragging nodes
      pixi.stage.eventMode = 'static';
      pixi.stage.hitArea = pixi.screen;
      pixi.stage.on('pointermove', (event) => {
        if (!dragged) return;
        dragMoved = true;
        // Move the node in the screen plane at its current depth: undo the perspective and rotation
        const point = world.toLocal(event.global);
        const index = dragged.index;
        const rx = point.x / perspective[index];
        const ry = point.y / perspective[index];
        const rz = depth[index];
        send({
          type: 'drag',
          index,
          x: rotation[0] * rx + rotation[3] * ry + rotation[6] * rz,
          y: rotation[1] * rx + rotation[4] * ry + rotation[7] * rz,
          z: rotation[2] * rx + rotation[5] * ry + rotation[8] * rz,
        });
      });
      const endDrag = () => {
        if (!dragged) return;
        const node = dragged;
        dragged = null;
        if (dragMoved) send({ type: 'release', index: node.index });
      };
      pixi.stage.on('pointerup', endDrag);
      pixi.stage.on('pointerupoutside', endDrag);

      // Follow the theme (light/dark)
      themeObserver = new MutationObserver(() => {
        colors = readColors();
        for (const node of nodes) drawNode(node);
        for (const label of labels.values()) label.style.fill = colors.text;
        dirty = true;
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    };

    void setup();

    return () => {
      disposed = true;
      themeObserver?.disconnect();
      send({ type: 'stop' });
      worker.terminate();
      if (zoomBehavior) zoomBehavior.on('zoom', null);
      if (app) {
        select(app.canvas as HTMLCanvasElement).on('.zoom', null);
        app.destroy(true, { children: true });
      }
    };
  }, [graph, status]);

  return (
    <div className="relative flex h-full flex-col">
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
        {(status !== 'ready' || !laidOut) && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-(--nav-label-color)">
            {(status === 'loading' || status === 'ready') && <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.75} />}
            {/* The left padding balances the dots, so the words stay centered under the icon */}
            {status === 'loading' && <span className="pl-[3ch]">{t('memoryGraph.loading')}<LoadingDots /></span>}
            {status === 'ready' && graph && (
              <span className="pl-[3ch]">
                {t('memoryGraph.layingOut', {
                  nodes: graph.nodes.length.toLocaleString(),
                  links: graph.links.length.toLocaleString(),
                })}
                <LoadingDots />
              </span>
            )}
            {status === 'empty' && t('memoryGraph.empty')}
            {status === 'error' && t('memoryGraph.loadFailed')}
          </div>
        )}
      </div>
    </div>
  );
}
