import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { formatDateTime } from '../../../shared/utils/format-date-time';
import { SettingsRow } from '../settings/SettingsRow';
import { StatusIndicator } from '../settings/common/StatusIndicator';
import { useGraphifyVersion } from '../../hooks/useGraphifyVersion';
import { useMemoryGraphStore } from '../../stores/memory-graph-store';
import type { GraphifyIndexInfo } from '../../../shared/types/cli';

/**
 * The Knowledge index row: builds a Graphify graph of the project's code into .workbench/knowledge,
 * placed under the project index in the Project page's Project section.
 */
export function MemoryIndexRows({ projectId }: { projectId: string }) {
  const { t } = useTranslation('settings');
  const graphifyInstalled = !!useGraphifyVersion().info?.installed;
  const useGraphify = useMemoryGraphStore((state) => !!state.enabled[projectId]);
  // Builds run in the store, so switching Use Graphify on can start one and the switch waits for it
  const isBuilding = useMemoryGraphStore((state) => !!state.building[projectId]);
  const error = useMemoryGraphStore((state) => state.buildError[projectId] ?? null);
  const revision = useMemoryGraphStore((state) => state.revision[projectId] ?? 0);
  const build = useMemoryGraphStore((state) => state.build);
  const [index, setIndex] = useState<GraphifyIndexInfo | null>(null);

  useEffect(() => {
    setIndex(null);
  }, [projectId]);

  // The last build's stats (a small local file, so reading it on open is cheap), read again after
  // each build (also the ones after a task completed); switching Use Graphify off removes them
  useEffect(() => {
    if (!useGraphify) {
      setIndex(null);
      return;
    }
    let cancelled = false;
    window.electronAPI.getGraphifyIndex(projectId).then((result) => {
      if (!cancelled && result.success) setIndex(result.data ?? null);
    }).catch(() => {
      // No graph to show
    });
    return () => { cancelled = true; };
  }, [projectId, useGraphify, revision]);

  const description = !graphifyInstalled
    ? t('projectPages.context.memoryIndexNotInstalled')
    : !useGraphify
      ? t('projectPages.context.memoryIndexNotEnabled')
      : index
        ? t('projectPages.context.memoryIndexDescription', {
            nodes: index.nodes.toLocaleString(),
            edges: index.edges.toLocaleString(),
            time: formatDateTime(index.builtAt),
          })
        : t('projectPages.context.noMemoryIndex');

  return (
    <>
      <SettingsRow label={t('projectPages.context.memoryIndex')} description={description}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void build(projectId)}
          disabled={!graphifyInstalled || !useGraphify || isBuilding}
          className="gap-2"
        >
          <RefreshCw className={cn('h-4 w-4', isBuilding && 'animate-spin')} strokeWidth={1.75} />
          {index ? t('projectPages.context.rebuildMemoryIndex') : t('projectPages.context.buildMemoryIndex')}
        </Button>
      </SettingsRow>

      {error !== null && (
        <SettingsRow
          label={
            <StatusIndicator state="error" tone="foreground">
              {t('projectPages.context.memoryIndexFailed')}
            </StatusIndicator>
          }
          description={error || undefined}
        />
      )}
    </>
  );
}
