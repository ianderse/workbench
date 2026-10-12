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
 * The Knowledge index row: builds a Graphify graph of the project's code into .auto-claude/knowledge,
 * placed under the project index in the Project page's Project section.
 */
export function MemoryIndexRows({ projectId, useGraphify }: { projectId: string; useGraphify: boolean }) {
  const { t } = useTranslation('settings');
  const graphifyInstalled = !!useGraphifyVersion().info?.installed;
  const [index, setIndex] = useState<GraphifyIndexInfo | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The last build's stats (a small local file, so reading it on open is cheap)
  useEffect(() => {
    let cancelled = false;
    setIndex(null);
    setError(null);
    window.electronAPI.getGraphifyIndex(projectId).then((result) => {
      if (!cancelled && result.success) setIndex(result.data ?? null);
    }).catch(() => {
      // No graph to show
    });
    return () => { cancelled = true; };
  }, [projectId]);

  // Rebuilt in the background after a task completed
  useEffect(
    () =>
      window.electronAPI.onGraphifyIndexUpdated((updatedProjectId, info) => {
        if (updatedProjectId === projectId) setIndex(info);
      }),
    [projectId]
  );

  const onBuild = async () => {
    setIsBuilding(true);
    setError(null);
    try {
      const result = await window.electronAPI.buildGraphifyIndex(projectId);
      if (result.success && result.data) {
        setIndex(result.data);
        // Show the sidebar's Memory item and reload an open graph view
        useMemoryGraphStore.getState().markRebuilt(projectId);
      } else {
        setError(result.error ?? '');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBuilding(false);
    }
  };

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
          onClick={onBuild}
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
