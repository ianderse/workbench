import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { formatDateTime } from '../../../shared/utils/format-date-time';
import { SettingsRow } from '../settings/SettingsRow';
import { StatusIndicator } from '../settings/common/StatusIndicator';
import { useProjectStore } from '../../stores/project-store';
import { useSelfLearningStore } from '../../stores/self-learning-store';

/**
 * The Memory index row: reads the project's past Claude Code sessions for the preferences the user
 * already stated and writes them as memories, so a project that switched self-learning on late
 * starts out knowing them. Placed under the project index in the Project page's Project section.
 *
 * Builds also start on their own when the switch goes on (Knowledge section), and the switch waits
 * for them; both places read the one build state, so either shows the other's progress.
 */
export function LearningIndexRows({ projectId }: { projectId: string }) {
  const { t } = useTranslation('settings');
  const selfLearning = useProjectStore(
    (state) => state.projects.find((project) => project.id === projectId)?.settings.selfLearning === true
  );
  const index = useSelfLearningStore((state) => state.index[projectId] ?? null);
  const isBuilding = useSelfLearningStore((state) => !!state.building[projectId]);
  const error = useSelfLearningStore((state) => state.buildError[projectId] ?? null);
  const refresh = useSelfLearningStore((state) => state.refresh);
  const build = useSelfLearningStore((state) => state.build);

  // Stats of the last build (a small local file, so reading it on open is cheap)
  useEffect(() => {
    if (selfLearning) void refresh(projectId);
  }, [projectId, selfLearning, refresh]);

  const description = !selfLearning
    ? t('projectPages.context.learningIndexNotEnabled')
    : isBuilding
      ? t('projectPages.context.learningIndexBuilding')
      : index
        ? t('projectPages.context.learningIndexDescription', {
            memories: index.memories,
            sessions: index.sessionsScanned,
            time: formatDateTime(index.builtAt),
          })
        : t('projectPages.context.noLearningIndex');

  return (
    <>
      <SettingsRow label={t('projectPages.context.learningIndex')} description={description}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void build(projectId)}
          disabled={!selfLearning || isBuilding}
          className="gap-2"
        >
          <RefreshCw className={cn('h-4 w-4', isBuilding && 'animate-spin')} strokeWidth={1.75} />
          {index
            ? t('projectPages.context.rebuildLearningIndex')
            : t('projectPages.context.buildLearningIndex')}
        </Button>
      </SettingsRow>

      {error !== null && (
        <SettingsRow
          label={
            <StatusIndicator state="error" tone="foreground">
              {t('projectPages.context.learningIndexFailed')}
            </StatusIndicator>
          }
          description={error || t('projectPages.context.learningIndexFailedUnknown')}
        />
      )}
    </>
  );
}
