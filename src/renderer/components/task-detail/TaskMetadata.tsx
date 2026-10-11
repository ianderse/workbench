import { useState, useRef, useLayoutEffect, useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { cn, formatRelativeTime } from '../../lib/utils';
import { JSON_ERROR_PREFIX } from '../../../shared/constants';
import type { Task, WorktreeStatus } from '../../../shared/types';
import { TaskAttachments } from './TaskAttachments';
import { MarkdownContent } from '../ui/markdown-content';

interface TaskMetadataProps {
  task: Task;
  /** The task worktree's change summary, shown under the description */
  worktreeStatus?: WorktreeStatus | null;
  /** Action shown at the right end of the change summary row (Create PR) */
  worktreeAction?: ReactNode;
}

// Height threshold for collapsing long descriptions (~8 lines)
const COLLAPSED_HEIGHT = 200;

/** Task sources that mean an agent created the task (e.g. a suggestion in the Claude chat) */
const AGENT_SOURCES = new Set(['insights', 'ideation', 'roadmap']);

export function TaskMetadata({ task, worktreeStatus, worktreeAction }: TaskMetadataProps) {
  const { t } = useTranslation(['tasks', 'errors', 'taskReview']);
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();

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
  }, [task.id, task.description]);

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
      {displayDescription && (
        <div className="max-w-full overflow-hidden rounded-xl bg-segment-track px-4 py-3">
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

      {/* Reference images attached to the task */}
      {task.metadata?.attachedImages && task.metadata.attachedImages.length > 0 && (
        <TaskAttachments task={task} images={task.metadata.attachedImages} />
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
