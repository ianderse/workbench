import { useState, useRef, useLayoutEffect, useId, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { cn, formatRelativeTime } from '../../lib/utils';
import { JSON_ERROR_PREFIX } from '../../../shared/constants';
import type { Task, WorktreeStatus } from '../../../shared/types';
import { MarkdownContent } from '../ui/markdown-content';
import { useTaskStore } from '../../stores/task-store';
import { useProjectStore } from '../../stores/project-store';
import { resolveTaskDependencies } from '../../../shared/utils/task-dependencies';

interface TaskMetadataProps {
  task: Task;
  /** The task worktree's change summary, shown under the description */
  worktreeStatus?: WorktreeStatus | null;
  /** Action shown at the right end of the change summary row (Create PR) */
  worktreeAction?: ReactNode;
  /** Keep the original request closed until opened (the "What was done" panel is read first) */
  collapseDescription?: boolean;
}

// Height threshold for collapsing long descriptions (~8 lines)
const COLLAPSED_HEIGHT = 200;

/** Task sources that mean an agent created the task (e.g. a suggestion in the Claude chat) */
const AGENT_SOURCES = new Set(['insights', 'ideation', 'roadmap']);

export function TaskMetadata({ task, worktreeStatus, worktreeAction, collapseDescription = false }: TaskMetadataProps) {
  const { t } = useTranslation(['tasks', 'errors', 'taskReview']);
  const [isExpanded, setIsExpanded] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(!collapseDescription);
  const descriptionOpenId = useId();
  const [hasOverflow, setHasOverflow] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const allTasks = useTaskStore((s) => s.tasks);
  const autonomous = useProjectStore((s) => s.projects.find((p) => p.id === task.projectId)?.settings?.autonomous === true);
  // Every ticket this one relies on, whatever its status
  const dependencies = useMemo(() => resolveTaskDependencies(allTasks, task, autonomous), [allTasks, task, autonomous]);

  // Handle JSON error description with i18n
  const displayDescription = (() => {
    if (!task.description) return null;
    if (task.description.startsWith(JSON_ERROR_PREFIX)) {
      const errorMessage = task.description.slice(JSON_ERROR_PREFIX.length);
      return t('errors:task.jsonError.description', { error: errorMessage });
    }
    return task.description;
  })();

  // Detect if content overflows the collapsed height
  // Re-check when description changes (content height depends on rendered description)
  // Reset expand state when switching tasks to avoid stale expanded state
  useLayoutEffect(() => {
    setIsExpanded(false);
    const element = contentRef.current;
    if (element) {
      const hasContentOverflow = element.scrollHeight > COLLAPSED_HEIGHT;
      setHasOverflow(hasContentOverflow);
    }
  }, [task.id, task.description, descriptionOpen]);

  // A different task starts closed again when the original request is collapsed
  useLayoutEffect(() => {
    setDescriptionOpen(!collapseDescription);
  }, [task.id, collapseDescription]);

  const origin = task.metadata
    ? [
        // Who created the task: suggested by an agent (Claude chat) or added by the user
        task.metadata.sourceType && {
          key: 'source',
          label: AGENT_SOURCES.has(task.metadata.sourceType) ? t('tasks:metadata.byAgent') : t('tasks:metadata.byUser')
        }
      ].filter(Boolean) as { key: string; label: string }[]
    : [];

  const metaItems: { key: string; label: string }[] = [
    ...origin,
    { key: 'created', label: t('tasks:metadata.created', { time: formatRelativeTime(task.createdAt) }) },
    { key: 'updated', label: t('tasks:metadata.updated', { time: formatRelativeTime(task.updatedAt) }) }
  ];

  const hasDetails = !!task.metadata && !!(
    task.metadata.rationale ||
    task.metadata.problemSolved ||
    task.metadata.targetAudience ||
    (task.metadata.dependencies && task.metadata.dependencies.length > 0) ||
    (task.metadata.acceptanceCriteria && task.metadata.acceptanceCriteria.length > 0) ||
    (task.metadata.affectedFiles && task.metadata.affectedFiles.length > 0)
  );

  return (
    <div className="space-y-4">
      {/* Origin + timeline as one muted line */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--nav-label-color)">
        {metaItems.map((item, idx) => (
          <span key={item.key} className="flex items-center gap-2">
            {idx > 0 && <span aria-hidden="true">·</span>}
            <span>{item.label}</span>
          </span>
        ))}
      </div>

      {/* Description - primary content in the claude info box */}
      {displayDescription && collapseDescription && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDescriptionOpen(!descriptionOpen)}
          className="-ml-2 text-muted-foreground hover:text-foreground"
          aria-expanded={descriptionOpen}
          aria-controls={descriptionOpenId}
        >
          {descriptionOpen ? <ChevronUp className="mr-1 h-4 w-4" aria-hidden="true" /> : <ChevronDown className="mr-1 h-4 w-4" aria-hidden="true" />}
          {t('tasks:workSummary.description')}
        </Button>
      )}
      {displayDescription && descriptionOpen && (
        <div id={descriptionOpenId} className="max-w-full overflow-hidden rounded-xl bg-segment-track px-4 py-3">
          {/* Rendered like the Claude chat's replies; long lines and images stay inside the box */}
          <MarkdownContent
            ref={contentRef}
            id={contentId}
            className={cn(
              'overflow-hidden prose-pre:overflow-x-auto [&_img]:h-auto [&_img]:max-w-full',
              // Fade the last lines out while collapsed
              !isExpanded && hasOverflow && 'max-h-[200px] [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'
            )}
            style={{ overflowWrap: 'anywhere' }}
          >
            {displayDescription}
          </MarkdownContent>

          {/* Expand/Collapse button */}
          {hasOverflow && (
            <div className="mt-2 flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsExpanded(!isExpanded)}
                className="text-muted-foreground hover:text-foreground"
                aria-expanded={isExpanded}
                aria-controls={contentId}
              >
                {isExpanded ? (
                  <>
                    <ChevronUp className="mr-1 h-4 w-4" aria-hidden="true" />
                    {t('tasks:metadata.showLess')}
                  </>
                ) : (
                  <>
                    <ChevronDown className="mr-1 h-4 w-4" aria-hidden="true" />
                    {t('tasks:metadata.showMore')}
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* The tickets this one relies on, with where each stands */}
      {dependencies.length > 0 && (
        <div className="text-sm">
          <p className="text-xs text-(--nav-label-color)">{t('tasks:metadata.reliesOn')}</p>
          <ul className="mt-1 space-y-0.5">
            {dependencies.map((dep) => (
              <li key={dep.ref} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 wrap-anywhere">
                  <span className="tabular-nums text-(--nav-label-color)">#{dep.number}</span>
                  {dep.title && <> {dep.title}</>}
                </span>
                <span className={cn('shrink-0 text-xs', dep.state === 'waiting' ? 'text-warning' : 'text-(--nav-label-color)')}>
                  {t(`tasks:metadata.reliesOnState.${dep.state}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Changes in the task's worktree */}
      {(worktreeStatus?.exists || worktreeAction) && (
        <div className="flex items-center gap-4">
          <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-(--nav-label-color)">
            {worktreeStatus?.exists && (<>
            <span>{t('taskReview:workspace.fileCount', { count: worktreeStatus.filesChanged || 0 })}</span>
            <span aria-hidden="true">·</span>
            <span>{t('taskReview:workspace.commitCount', { count: worktreeStatus.commitCount || 0 })}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums text-success">+{worktreeStatus.additions || 0}</span>
            <span className="tabular-nums text-destructive">-{worktreeStatus.deletions || 0}</span>
            </>)}
          </p>
          {worktreeAction}
        </div>
      )}

      {/* Secondary details as plain rows */}
      {task.metadata && hasDetails && (
        <SettingsRows>
          {task.metadata.rationale && (
            <SettingsRow label={t('tasks:metadata.rationale')} description={task.metadata.rationale} />
          )}

          {task.metadata.problemSolved && (
            <SettingsRow label={t('tasks:metadata.problemSolved')} description={task.metadata.problemSolved} />
          )}

          {task.metadata.targetAudience && (
            <SettingsRow label={t('tasks:metadata.targetAudience')} description={task.metadata.targetAudience} />
          )}

          {task.metadata.dependencies && task.metadata.dependencies.length > 0 && (
            <SettingsRow
              label={t('tasks:metadata.dependencies')}
              description={
                <ul className="list-inside list-disc space-y-0.5">
                  {task.metadata.dependencies.map((dep, idx) => (
                    <li key={idx}>{dep}</li>
                  ))}
                </ul>
              }
            />
          )}

          {task.metadata.acceptanceCriteria && task.metadata.acceptanceCriteria.length > 0 && (
            <SettingsRow
              label={t('tasks:metadata.acceptanceCriteria')}
              description={
                <ul className="list-inside list-disc space-y-0.5">
                  {task.metadata.acceptanceCriteria.map((criteria, idx) => (
                    <li key={idx}>{criteria}</li>
                  ))}
                </ul>
              }
            />
          )}

          {task.metadata.affectedFiles && task.metadata.affectedFiles.length > 0 && (
            <SettingsRow
              label={t('tasks:metadata.affectedFiles')}
              description={
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {task.metadata.affectedFiles.map((file, idx) => (
                    <Tooltip key={idx}>
                      <TooltipTrigger asChild>
                        <span className="cursor-help font-mono text-xs">{file.split('/').pop()}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="font-mono text-xs">
                        {file}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              }
            />
          )}
        </SettingsRows>
      )}
    </div>
  );
}
