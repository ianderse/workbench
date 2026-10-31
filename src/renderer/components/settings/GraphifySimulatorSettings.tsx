import { lazy, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Shuffle } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { SettingsSection } from './SettingsSection';
import { SegmentedControl, SettingsRow, SettingsRows, type SegmentedOption } from './SettingsRow';
import { GraphColorIcon, GraphIcon } from '../icons/app-icons';
import { IS_DEV_BUILD } from '../../lib/title-bar';
import { RANDOM_GRAPH_LIMITS } from '../memory/random-graph';
import { createGraphViewSync } from '../memory/graph-view-sync';
import { useGraphifySimulatorStore } from '../../stores/graphify-simulator-store';

// The graph view (PixiJS) is a large module; it loads when the page is opened, as on the Graph page
const MemoryGraph = lazy(() => import('../memory/MemoryGraph').then((module) => ({ default: module.MemoryGraph })));

/** The two preview boxes: dark first, then light, whatever the app's theme */
const PREVIEW_THEMES = ['dark', 'light'] as const;

type Style = 'plain' | 'colorful';

/**
 * Development builds only: the Graphify graph view (the Graph page's) in the dark and the light
 * theme side by side, two equal squares across the page's width, showing a random graph of the
 * chosen size, plain or colorful.
 */
export function GraphifySimulatorSettings() {
  const { t } = useTranslation('settings');
  const nodes = useGraphifySimulatorStore((state) => state.nodes);
  const edges = useGraphifySimulatorStore((state) => state.edges);
  const setNodes = useGraphifySimulatorStore((state) => state.setNodes);
  const setEdges = useGraphifySimulatorStore((state) => state.setEdges);
  const graph = useGraphifySimulatorStore((state) => state.graph);
  const generate = useGraphifySimulatorStore((state) => state.generate);
  const colorful = useGraphifySimulatorStore((state) => state.colorful);
  const setColorful = useGraphifySimulatorStore((state) => state.setColorful);
  // The two previews turn, zoom and drag as one; a new graph starts them in step again
  const sync = useMemo(() => createGraphViewSync(), [graph]);

  if (!IS_DEV_BUILD) return null;

  const styleOptions: SegmentedOption<Style>[] = [
    { value: 'plain', label: t('theme.graphPlain'), icon: GraphIcon },
    { value: 'colorful', label: t('theme.graphColorful'), icon: GraphColorIcon },
  ];

  return (
    <SettingsSection title={t('graphifySimulator.title')}>
      <div className="grid grid-cols-2 gap-4">
        {PREVIEW_THEMES.map((theme) => (
          // The Graph page's background and text, in this theme
          <div
            key={theme}
            className={`${theme} aspect-square w-full overflow-hidden rounded-xl border border-border bg-background text-foreground`}
          >
            <Suspense fallback={null}>
              <MemoryGraph graph={graph} colorful={colorful} sync={sync} />
            </Suspense>
          </div>
        ))}
      </div>

      <SettingsRows className="mt-4">
        <SettingsRow
          label={t('graphifySimulator.size')}
          description={t('graphifySimulator.sizeDescription')}
        >
          <Input
            type="number"
            min={0}
            max={RANDOM_GRAPH_LIMITS.nodes}
            className="w-24"
            aria-label={t('graphifySimulator.nodes')}
            placeholder={t('graphifySimulator.nodes')}
            value={nodes}
            onChange={(e) => setNodes(Number(e.target.value))}
            onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
          />
          <Input
            type="number"
            min={0}
            max={RANDOM_GRAPH_LIMITS.edges}
            className="w-24"
            aria-label={t('graphifySimulator.edges')}
            placeholder={t('graphifySimulator.edges')}
            value={edges}
            onChange={(e) => setEdges(Number(e.target.value))}
            onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
          />
          <Button variant="outline" size="sm" className="gap-1.5" onClick={generate}>
            <Shuffle className="h-3.5 w-3.5" />
            {t('graphifySimulator.generate')}
          </Button>
        </SettingsRow>
        <SettingsRow label={t('graphifySimulator.style')} description={t('graphifySimulator.styleDescription')}>
          <SegmentedControl
            value={colorful ? 'colorful' : 'plain'}
            options={styleOptions}
            onValueChange={(style) => setColorful(style === 'colorful')}
            ariaLabel={t('graphifySimulator.style')}
            iconOnly
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
