import { isHumanApprovalOverride } from '../../../../shared/utils/human-work';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '../../ui/button';
import { MarkdownContent } from '../../ui/markdown-content';
import { cn } from '../../../lib/utils';
import { useSettingsStore } from '../../../stores/settings-store';
import { reviewInterruption } from '../../../../shared/utils/task-resume';
import { readRefreshCache, writeRefreshCache } from '../../../lib/refresh-cache';
import { formatCostUsd, formatDurationMs } from '../../../../shared/utils/claude-run';
import { formatFindingLocation } from '../../../../shared/utils/ai-review-loop';
import {
  buildWorkSummary,
  changeStatsLine,
  hasWorkSummary,
  reviewSummaryMode,
  shouldGenerateReviewSummary,
  topChangedFiles,
  type ReviewSummaryGeneration,
} from '../../../../shared/utils/task-work-summary';
import { taskNumber } from '../../../../shared/utils/queue-grooming';
import type { Task, TaskChangeSummary } from '../../../../shared/types';

interface WhatWasDonePanelProps {
  task: Task;
}

/** Height of the collapsed agent notes (about 3 lines) */
const COLLAPSED_HEIGHT = 72;
const MAX_FILES_SHOWN = 6;

/** Tasks whose summary could not be written this session: not asked again until the user presses Regenerate */
const failedSummaries = new Set<string>();

/** Whether the panel has anything to show for a task */
export function shouldShowWhatWasDone(task: Task): boolean {
  // A Spec review ticket has its own panel and changes no code
  if (task.metadata?.specReview) return false;
  return task.status === 'human_review' && hasWorkSummary(task.claudeRun);
}

/**
 * The changed files, read once per run and kept in the refresh cache: showing a ticket again
 * (or opening it from the board) never runs git again for a run it already saw.
 */
function useTaskChanges(task: Task): TaskChangeSummary | null {
  const cacheKey = `task-changes:${task.projectId}:${task.id}:${task.claudeRun?.updatedAt ?? ''}`;
  const [changes, setChanges] = useState<TaskChangeSummary | null>(() => readRefreshCache<TaskChangeSummary>(cacheKey) ?? null);

  useEffect(() => {
    const cached = readRefreshCache<TaskChangeSummary>(cacheKey);
    if (cached) {
      setChanges(cached);
      return;
    }
    setChanges(null);
    let cancelled = false;
    window.electronAPI
      .getTaskChangeSummary(task.id, task.projectId)
      .then((result) => {
        if (cancelled || !result.success || !result.data) return;
        writeRefreshCache(cacheKey, result.data);
        setChanges(result.data);
      })
      .catch(() => {
        // The panel just leaves the changes out
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, task.id, task.projectId]);

  return changes;
}

/**
 * Top of a task in Human Review: what the agent did, how it checked itself, what it changed and
 * what it cost. The original request sits below it, closed.
 */
export function WhatWasDonePanel({ task }: WhatWasDonePanelProps) {
  const { t } = useTranslation('tasks');
  const work = useMemo(() => buildWorkSummary(task.claudeRun), [task.claudeRun]);
  const changes = useTaskChanges(task);
  const validationOn = useSettingsStore((s) => s.settings.claudeCodeTasks?.validation) !== false;
  const interruption = reviewInterruption(task, validationOn);
  const title = interruption === 'stopped'
    ? t('workSummary.titleStopped')
    : interruption === 'interrupted'
      ? t('workSummary.titleInterrupted')
      : t('workSummary.title');
  // A string, so it only changes when the tickets do
  const created = task.metadata?.followUpTickets;
  const followUpLine = created && created.length > 0
    ? t('queueGrooming.followUpsCreated', {
        count: created.length,
        list: created
          .map((c) => t(c.action === 'queue' ? 'queueGrooming.followUpQueued' : 'queueGrooming.followUpPlanning', { number: taskNumber(c.taskId) }))
          .join(', '),
      })
    : '';
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [generation, setGeneration] = useState<ReviewSummaryGeneration>('idle');
  const summaryKey = `${task.projectId}:${task.id}`;
  const hasReviewSummary = !!task.claudeRun?.reviewSummary;
  const mode = reviewSummaryMode(task.claudeRun, generation);
  const wantsSummary = shouldGenerateReviewSummary(task);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();

  const requestSummary = useCallback(
    (force: boolean) => {
      let live = true;
      failedSummaries.delete(summaryKey);
      setGeneration('pending');
      window.electronAPI
        .generateReviewSummary(task.id, task.projectId, force)
        .then((result) => {
          if (!result.success || !result.data) failedSummaries.add(summaryKey);
          if (live) setGeneration(result.success && result.data ? 'idle' : 'failed');
        })
        .catch(() => {
          failedSummaries.add(summaryKey);
          if (live) setGeneration('failed');
        });
      return () => {
        live = false;
      };
    },
    [summaryKey, task.id, task.projectId]
  );

  // A ticket that finished before summaries existed gets one written the first time it is opened;
  // it is stored, so it is never written again on open
  useEffect(() => {
    setGeneration(failedSummaries.has(summaryKey) ? 'failed' : 'idle');
    if (!wantsSummary || failedSummaries.has(summaryKey)) return undefined;
    return requestSummary(false);
  }, [summaryKey, wantsSummary, requestSummary]);

  useLayoutEffect(() => {
    setExpanded(false);
    const el = contentRef.current;
    setOverflows(!!el && el.scrollHeight > COLLAPSED_HEIGHT);
  }, [task.id, work.summary, mode]);

  const { review, checks, findings, effort } = work;
  const reviewText =
    review.kind === 'passed'
      ? isHumanApprovalOverride(task.claudeRun?.reviewVerdict?.humanApprovalOverride)
        ? t('humanWork.reviewAcceptedOverride')
        : t('workSummary.review.passed', { rounds: review.rounds, max: review.maxRounds })
      : review.kind === 'failed'
        ? t('workSummary.review.failed', { rounds: review.rounds, max: review.maxRounds })
        : t('workSummary.review.none');
  const checksText = checks
    ? checks.failing.length > 0
      ? t('workSummary.checksFailing', { passed: checks.passed, total: checks.total, names: checks.failing.join(', ') })
      : t('workSummary.checks', { passed: checks.passed, total: checks.total })
    : t('workSummary.noChecks');
  const findingParts = (['critical', 'major', 'minor'] as const)
    .filter((severity) => findings[severity] > 0)
    .map((severity) => t(`workSummary.findings.${severity}`, { count: findings[severity] }));
  // A failed AI review already lists its open findings in its own panel
  const listFindings = findings.open.length > 0 && review.kind !== 'failed';

  const stats = changeStatsLine(changes ?? { files: [], additions: 0, deletions: 0 });
  const { shown, more } = changes ? topChangedFiles(changes.files, MAX_FILES_SHOWN) : { shown: [], more: 0 };
  const modelText =
    effort.models.length === 1
      ? t('workSummary.effort.model', { model: effort.models[0].model })
      : effort.models.length > 1
        ? t('workSummary.effort.models', {
            list: effort.models
              .map((m) => t('workSummary.effort.modelEntry', { phases: m.phases.join(', '), model: m.model }))
              .join('; '),
          })
        : null;
  const effortParts = [
    effort.durationMs > 0 ? t('workSummary.effort.time', { time: formatDurationMs(effort.durationMs) }) : null,
    effort.costUsd > 0 ? t('workSummary.effort.cost', { cost: formatCostUsd(effort.costUsd) }) : null,
    modelText,
  ].filter((part): part is string => part !== null);

  return (
    <section
      role="region"
      aria-label={title}
      className="rounded-lg border border-border bg-card/60 p-4"
    >
      <h3 className="text-sm font-medium text-foreground">{title}</h3>

      {task.claudeRun?.reviewSummary && (
        <div className="mt-2 space-y-3">
          <p className="text-base font-medium leading-snug text-foreground wrap-anywhere">{task.claudeRun.reviewSummary.headline}</p>
          <div>
            <h4 className="text-xs font-medium text-(--nav-label-color)">{t('workSummary.whatChanged')}</h4>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-foreground">
              {task.claudeRun.reviewSummary.whatChanged.map((item) => (
                <li key={item} className="wrap-anywhere">{item}</li>
              ))}
            </ul>
          </div>
          {task.claudeRun.reviewSummary.verified && (
            <p className="text-sm text-foreground wrap-anywhere">
              <span className="text-xs font-medium text-(--nav-label-color)">{t('workSummary.checked')}</span>
              <span className="ml-2">{task.claudeRun.reviewSummary.verified}</span>
            </p>
          )}
          {task.claudeRun.reviewSummary.needsAttention.length > 0 && (
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <h4 className="text-xs font-medium text-foreground">{t('workSummary.needsAttention')}</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-foreground">
                {task.claudeRun.reviewSummary.needsAttention.map((item) => (
                  <li key={item} className="wrap-anywhere">{item}</li>
                ))}
              </ul>
              {followUpLine && <p className="mt-2 text-xs text-(--nav-label-color) wrap-anywhere">{followUpLine}</p>}
            </div>
          )}
        </div>
      )}

      {mode === 'pending' && <p className="mt-2 text-sm text-(--nav-label-color)">{t('workSummary.writing')}</p>}

      {(wantsSummary || hasReviewSummary) && (generation !== 'pending' || hasReviewSummary) && (
        <div className="mt-1 flex items-center gap-2">
          {generation === 'pending' && <span className="text-xs text-(--nav-label-color)">{t('workSummary.writing')}</span>}
          {generation !== 'pending' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => requestSummary(true)}
            >
              {t('workSummary.regenerate')}
            </Button>
          )}
        </div>
      )}

      {mode !== 'summary' && (
      work.summary ? (
        <div className="mt-2">
          <MarkdownContent
            ref={contentRef}
            id={contentId}
            className={cn(
              'overflow-hidden prose-pre:overflow-x-auto [&_img]:h-auto [&_img]:max-w-full',
              !expanded && overflows && 'max-h-[72px] [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'
            )}
            style={{ overflowWrap: 'anywhere' }}
          >
            {work.summary}
          </MarkdownContent>
          {overflows && (
            <div className="mt-1 flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded(!expanded)}
                className="text-muted-foreground hover:text-foreground"
                aria-expanded={expanded}
                aria-controls={contentId}
              >
                {expanded ? <ChevronUp className="mr-1 h-4 w-4" aria-hidden="true" /> : <ChevronDown className="mr-1 h-4 w-4" aria-hidden="true" />}
                {t(expanded ? 'workSummary.showLess' : 'workSummary.showMore')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-2 text-sm text-(--nav-label-color)">{t('workSummary.noSummary')}</p>
      )
      )}

      <ul className="mt-3 space-y-1 text-sm text-foreground">
        <li>{reviewText}</li>
        {!!findings.overridden?.length && <li>{t('humanWork.overriddenFindings', { count: findings.overridden.length })}</li>}
        <li className="wrap-anywhere">{checksText}</li>
        <li>
          {findingParts.length > 0
            ? t('workSummary.findings.summary', { parts: findingParts.join(', ') })
            : t('workSummary.findings.none')}
          {listFindings && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-2 h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setFindingsOpen(!findingsOpen)}
              aria-expanded={findingsOpen}
            >
              {t(findingsOpen ? 'workSummary.findings.hide' : 'workSummary.findings.show')}
            </Button>
          )}
        </li>
      </ul>

      {listFindings && findingsOpen && (
        <ul className="mt-1 space-y-1 border-l border-border pl-3">
          {findings.open.map((finding, i) => {
            const where = formatFindingLocation(finding);
            return (
              <li key={`${i}-${finding.description}`} className="text-sm text-foreground wrap-anywhere">
                <span className="text-xs uppercase text-(--nav-label-color)">{finding.severity}</span>
                {where && <code className="ml-2 text-xs">{where}</code>}
                <span className="ml-2">{finding.description}</span>
              </li>
            );
          })}
        </ul>
      )}

      {changes && (changes.files.length > 0 || changes.commitCount !== undefined) && (
        <div className="mt-3">
          <p className="text-xs text-(--nav-label-color)">
            {t('workSummary.changes.line', {
              count: stats.files,
              additions: stats.additions.toLocaleString(),
              deletions: stats.deletions.toLocaleString(),
            })}
            {stats.commits > 0 ? `, ${t('workSummary.changes.commits', { count: stats.commits })}` : ''}
            {shown.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-2 h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setFilesOpen(!filesOpen)}
                aria-expanded={filesOpen}
              >
                {t(filesOpen ? 'workSummary.hideFiles' : 'workSummary.showFiles')}
              </Button>
            )}
          </p>
          {filesOpen && shown.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {shown.map((file) => (
                <li key={file.path} className="flex items-baseline gap-2 text-xs">
                  <code className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</code>
                  <span className="tabular-nums text-success">+{file.additions}</span>
                  <span className="tabular-nums text-destructive">-{file.deletions}</span>
                </li>
              ))}
              {more > 0 && <li className="text-xs text-(--nav-label-color)">{t('workSummary.changes.more', { count: more })}</li>}
            </ul>
          )}
        </div>
      )}

      {mode === 'summary' && work.summary && (
        <div className="mt-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setNotesOpen(!notesOpen)}
            aria-expanded={notesOpen}
          >
            {t('workSummary.technicalNotes')}
          </Button>
          {notesOpen && (
            <MarkdownContent className="mt-1 overflow-hidden prose-pre:overflow-x-auto [&_img]:h-auto [&_img]:max-w-full" style={{ overflowWrap: 'anywhere' }}>
              {work.summary}
            </MarkdownContent>
          )}
        </div>
      )}

      {effortParts.length > 0 && (
        <p className="mt-3 text-xs text-(--nav-label-color) wrap-anywhere">{effortParts.join(' · ')}</p>
      )}
    </section>
  );
}
