import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { Button } from '../ui/button';
import { SettingsRow, SettingsRows } from './SettingsRow';
import {
  CHILD_KINDS,
  MASTER_ID,
  useLiveAgentSimulatorStore,
  type SimNode,
  type SimNodeKind,
} from '../../stores/live-agent-simulator-store';

// The graph is a large module; it loads when the page is opened, as in an agent window
const LiveAgentPreview = lazy(() => import('../live-agent/LiveAgentPreview'));

/** The two preview boxes: dark first, then light, whatever the app's theme */
const PREVIEW_THEMES = ['dark', 'light'] as const;

/** How far each level of the tree is indented */
const INDENT_PX = 24;

/** The "+ Subtask", "+ Subagent", "+ Tool" buttons for what can go under a node */
function AddButtons({ parentId, kinds }: { parentId: string; kinds: SimNodeKind[] }) {
  const { t } = useTranslation('settings');
  const add = useLiveAgentSimulatorStore((state) => state.add);
  return (
    <>
      {kinds.map((kind) => (
        <Button key={kind} variant="outline" size="sm" className="gap-1" onClick={() => add(parentId, kind)}>
          <Plus className="h-3.5 w-3.5" />
          {t(`liveAgentSimulator.kinds.${kind}`)}
        </Button>
      ))}
    </>
  );
}

/** A node's row: its name, what can be added under it, and a button removing it with its children */
function NodeRow({ node, depth }: { node: SimNode; depth: number }) {
  const { t } = useTranslation('settings');
  const remove = useLiveAgentSimulatorStore((state) => state.remove);
  const label = node.kind === 'tool'
    ? t('liveAgentSimulator.toolNode', { tool: node.tool })
    : t(`liveAgentSimulator.nodes.${node.kind}`, { n: node.n });
  return (
    <div style={{ paddingLeft: depth * INDENT_PX }}>
      <SettingsRow label={label}>
        {node.kind !== 'tool' && <AddButtons parentId={node.id} kinds={CHILD_KINDS[node.kind]} />}
        <Button
          variant="ghost"
          size="sm"
          className="w-8 px-0"
          aria-label={t('liveAgentSimulator.remove')}
          onClick={() => remove(node.id)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </SettingsRow>
    </div>
  );
}

/**
 * Development builds only, inside the Simulation section: the live agent graph in the dark and
 * the light theme side by side (two equal squares across the page's width), showing the master
 * node and the tree built under it with the rows below. Each subtask, subagent and tool gets a
 * row under its parent's, indented like a tree.
 */
export function LiveAgentSimulatorSettings() {
  const { t } = useTranslation('settings');
  const nodes = useLiveAgentSimulatorStore((state) => state.nodes);

  // Depth-first, so each node's row comes right under its parent's
  const rows: { node: SimNode; depth: number }[] = [];
  const walk = (parentId: string, depth: number) => {
    for (const node of nodes) {
      if (node.parentId !== parentId) continue;
      rows.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(MASTER_ID, 1);

  return (
    <div className="mt-8">
      <div className="grid grid-cols-2 gap-4">
        {PREVIEW_THEMES.map((theme) => (
          <Suspense key={theme} fallback={<div className="aspect-square w-full" />}>
            <LiveAgentPreview theme={theme} />
          </Suspense>
        ))}
      </div>

      <SettingsRows className="mt-4">
        <SettingsRow
          label={t('liveAgentSimulator.masterNode')}
          description={t('liveAgentSimulator.masterNodeDescription')}
        >
          <AddButtons parentId={MASTER_ID} kinds={CHILD_KINDS.master} />
        </SettingsRow>
        {rows.map(({ node, depth }) => <NodeRow key={node.id} node={node} depth={depth} />)}
      </SettingsRows>
    </div>
  );
}
