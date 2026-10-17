import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { formatDateTime } from '../../../shared/utils/format-date-time';
import { SettingsRow } from '../settings/SettingsRow';
import { StatusIndicator } from '../settings/common/StatusIndicator';
import { useProjectStore } from '../../stores/project-store';
import { useSelfImproveStore } from '../../stores/self-improve-store';

/**
 * The Memory index row: reads the project's past Claude Code sessions for the preferences the user
 * already stated and writes them as memories, so a project that switched self-improve on late
 * starts out knowing them. Placed under the project index in the Project page's Project section.
 *
 * Builds also start on their own when the switch goes on (Knowledge section), and the switch waits
 * for them; both places read the one build state, so either shows the other's progress.
 */
export function CompengIndexRows({ projectId }: { projectId: string }) {
  const { t } = useTranslation('settings');
  const selfImprove = useProjectStore(
    (state) => state.projects.find((project) => project.id === projectId)?.settings.selfImprove === true
  );
  const index = useSelfImproveStore((state) => state.index[projectId] ?? null);
  const isBuilding = useSelfImproveStore((state) => !!state.building[projectId]);
  const error = useSelfImproveStore((state) => state.buildError[projectId] ?? null);
  const refresh = useSelfImproveStore((state) => state.refresh);
  const build = useSelfImproveStore((state) => state.build);

  // Stats of the last build (a small local file, so reading it on open is cheap)
  useEffect(() => {
    if (selfImprove) void refresh(projectId);
  }, [projectId, selfImprove, refresh]);

  const description = !selfImprove
    ? t('projectPages.context.compengIndexNotEnabled')
    : isBuilding
      ? t('projectPages.context.compengIndexBuilding')
      : index
        ? t('projectPages.context.compengIndexDescription', {
            memories: index.memories,
            sessions: index.sessionsScanned,
            time: formatDateTime(index.builtAt),
          })
        : t('projectPages.context.noCompengIndex');

  return (
    <>
      <SettingsRow label={t('projectPages.context.compengIndex')} description={description}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void build(projectId)}
          disabled={!selfImprove || isBuilding}
          className="gap-2"
        >
          <RefreshCw className={cn('h-4 w-4', isBuilding && 'animate-spin')} strokeWidth={1.75} />
          {index
            ? t('projectPages.context.rebuildCompengIndex')
            : t('projectPages.context.buildCompengIndex')}
        </Button>
      </SettingsRow>

      {error !== null && (
        <SettingsRow
          label={
            <StatusIndicator state="error" tone="foreground">
              {t('projectPages.context.compengIndexFailed')}
            </StatusIndicator>
          }
          description={error || t('projectPages.context.compengIndexFailedUnknown')}
        />
      )}
    </>
  );
}
