import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
// The app's Content Security Policy forbids eval; this makes PixiJS build its shaders without it
import 'pixi.js/unsafe-eval';
import { Application, Circle, Color, Container, Graphics, Text } from 'pixi.js';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { Loader2 } from 'lucide-react';
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

/**
 * Obsidian-style graph view of the project's memory graph (Graphify's graph.json). Like Obsidian,
 * the d3-force layout runs in a Web Worker and PixiJS draws the graph with WebGL. Wheel or drag the
 * background to zoom and pan, drag nodes to move them and hover to highlight a node's neighbours.
 */
export function MemoryGraph({ projectId }: { projectId: string }) {
  const { t } = useTranslation('navigation');
  const containerRef = useRef<HTMLDivElement>(null);
  const revision = useMemoryGraphStore((state) => state.revision[projectId] ?? 0);
  const [graph, setGraph] = useState<GraphifyGraph | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');

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
    let positions: Float32Array<ArrayBufferLike> = new Float32Array(nodes.length * 2);
    const byConnections = [...nodes].sort((a, b) => b.connections - a.connections);
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

      const drawNode = (node: ViewNode) => {
        const isHovered = hovered?.index === node.index;
        nodeGraphics[node.index]
          .clear()
          .circle(0, 0, node.radius)
          .fill({ color: isHovered ? colors.accent : colors.node, alpha: isHovered ? 1 : 0.75 });
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
            const x = positions[node.index * 2];
            const y = positions[node.index * 2 + 1];
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
          label.position.set(positions[index * 2], positions[index * 2 + 1] + node.radius * (k > 1 ? 1 / Math.sqrt(k) : 1) + 2 / Math.max(k, 1));
        }
      };

      const drawLinks = () => {
        linkLayer.clear();
        const width = 1 / transform.k;
        if (hovered) {
          // Dim every link, then draw the hovered node's links on top
          for (const [s, t] of linkPairs) {
            linkLayer.moveTo(positions[s * 2], positions[s * 2 + 1]).lineTo(positions[t * 2], positions[t * 2 + 1]);
          }
          linkLayer.stroke({ width, color: colors.link, alpha: 0.04 });
          for (const [s, t] of linkPairs) {
            if (s !== hovered.index && t !== hovered.index) continue;
            linkLayer.moveTo(positions[s * 2], positions[s * 2 + 1]).lineTo(positions[t * 2], positions[t * 2 + 1]);
          }
          linkLayer.stroke({ width: width * 1.5, color: colors.accent, alpha: 0.9 });
        } else {
          for (const [s, t] of linkPairs) {
            linkLayer.moveTo(positions[s * 2], positions[s * 2 + 1]).lineTo(positions[t * 2], positions[t * 2 + 1]);
          }
          linkLayer.stroke({ width, color: colors.link, alpha: 0.12 });
        }
      };

      const render = () => {
        // Zoomed in, nodes grow slower than the distances between them (like Obsidian)
        const nodeScale = transform.k > 1 ? 1 / Math.sqrt(transform.k) : 1;
        for (const node of nodes) {
          const g = nodeGraphics[node.index];
          g.position.set(positions[node.index * 2], positions[node.index * 2 + 1]);
          g.scale.set(nodeScale);
          g.alpha = inFocus(node.index) ? 1 : 0.15;
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

      // Zoom and pan with d3-zoom (not while dragging a node)
      const canvas = pixi.canvas as HTMLCanvasElement;
      zoomBehavior = zoom<HTMLCanvasElement, unknown>()
        .scaleExtent([0.02, 8])
        .filter((event: Event) => !dragged && !(event.type === 'mousedown' && hovered))
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
          const x = positions[i * 2], y = positions[i * 2 + 1], r = nodes[i].radius;
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
        // Keep the graph in view while it spreads out, until the user zooms or pans
        if (!userMoved) fitToView();
        world.visible = true;
        dirty = true;
      };
      send({ type: 'init', radii: nodes.map((node) => node.radius), links: linkPairs });

      // Draw at most once per frame, only when something changed
      pixi.ticker.add(() => {
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
        const point = world.toLocal(event.global);
        send({ type: 'drag', index: dragged.index, x: point.x, y: point.y });
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
        {status !== 'ready' && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-(--nav-label-color)">
            {status === 'loading' && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />}
            {status === 'loading' && t('memoryGraph.loading')}
            {status === 'empty' && t('memoryGraph.empty')}
            {status === 'error' && t('memoryGraph.loadFailed')}
          </div>
        )}
      </div>
    </div>
  );
}
