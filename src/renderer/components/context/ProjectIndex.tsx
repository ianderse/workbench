import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { formatDateTime } from '../../../shared/utils/format-date-time';
import { SettingsRow } from '../settings/SettingsRow';
import { StatusIndicator } from '../settings/common/StatusIndicator';
import { useProjectStore } from '../../stores/project-store';
import { useProjectIndexStore } from '../../stores/project-index-store';

/**
 * The project index row: runs Claude Code's own `/init` over the project and writes the CLAUDE.md
 * every session in it reads, which is what the project is indexed as for the agents. First row of
 * the Project page's Project section, above the Knowledge and Memory indexes.
 *
 * The first CLAUDE.md is written by switching Use CLAUDE.md on (Knowledge section), and the switch
 * waits for it; both places read the one build state, so either shows the other's progress. This
 * row rewrites the file, which is how a project folds in what changed since the last run.
 */
export function ProjectIndexRows({ projectId }: { projectId: string }) {
  const { t } = useTranslation('settings');
  const useClaudeMd = useProjectStore(
    (state) => state.projects.find((project) => project.id === projectId)?.settings.useClaudeMd !== false
  );
  // undefined until the project's CLAUDE.md has been checked for, null when it has none
  const stored = useProjectIndexStore((state) => state.index[projectId]);
  const index = stored ?? null;
  // Use CLAUDE.md is on only while the project has one, so that is what this row waits for too
  const enabled = useClaudeMd && !!index;
  const isBuilding = useProjectIndexStore((state) => !!state.building[projectId]);
  const error = useProjectIndexStore((state) => state.buildError[projectId] ?? null);
  const refresh = useProjectIndexStore((state) => state.refresh);
  const build = useProjectIndexStore((state) => state.build);

  // Stats of the file itself (a small local read, so checking for it on open is cheap)
  useEffect(() => {
    if (stored === undefined) void refresh(projectId);
  }, [stored, projectId, refresh]);

  const description = isBuilding
    ? t('projectPages.context.projectIndexBuilding')
    : !enabled
      ? t('projectPages.context.projectIndexNotEnabled')
      : t('projectPages.context.projectIndexDescription', {
          lines: index.lines.toLocaleString(),
          time: formatDateTime(index.builtAt),
        });

  return (
    <>
      <SettingsRow label={t('projectPages.context.projectIndex')} description={description}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void build(projectId)}
          disabled={!enabled || isBuilding}
          className="gap-2"
        >
          <RefreshCw className={cn('h-4 w-4', isBuilding && 'animate-spin')} strokeWidth={1.75} />
          {t('projectPages.context.rebuildProjectIndex')}
        </Button>
      </SettingsRow>

      {error !== null && (
        <SettingsRow
          label={
            <StatusIndicator state="error" tone="foreground">
              {t('projectPages.context.projectIndexFailed')}
            </StatusIndicator>
          }
          description={error || t('projectPages.context.projectIndexFailedUnknown')}
        />
      )}
    </>
  );
}
