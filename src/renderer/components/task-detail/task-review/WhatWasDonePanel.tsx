import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '../../ui/button';
import { MarkdownContent } from '../../ui/markdown-content';
import { cn } from '../../../lib/utils';
import { readRefreshCache, writeRefreshCache } from '../../../lib/refresh-cache';
import { formatCostUsd, formatDurationMs } from '../../../../shared/utils/claude-run';
import { formatFindingLocation } from '../../../../shared/utils/ai-review-loop';
import { buildWorkSummary, hasWorkSummary, topChangedFiles } from '../../../../shared/utils/task-work-summary';
import type { Task, TaskChangeSummary } from '../../../../shared/types';

interface WhatWasDonePanelProps {
  task: Task;
}

/** Height of the collapsed summary (about 8 lines) */
const COLLAPSED_HEIGHT = 200;
const MAX_FILES_SHOWN = 6;

/** Whether the panel has anything to show for a task */
export function shouldShowWhatWasDone(task: Task): boolean {
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
  const partial = task.reviewReason === 'stopped';
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();

  useLayoutEffect(() => {
    setExpanded(false);
    const el = contentRef.current;
    setOverflows(!!el && el.scrollHeight > COLLAPSED_HEIGHT);
  }, [task.id, work.summary]);

  const { review, checks, findings, effort } = work;
  const reviewText =
    review.kind === 'passed'
      ? t('workSummary.review.passed', { rounds: review.rounds, max: review.maxRounds })
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
      aria-label={t(partial ? 'workSummary.titlePartial' : 'workSummary.title')}
      className="rounded-lg border border-border bg-card/60 p-4"
    >
      <h3 className="text-sm font-medium text-foreground">{t(partial ? 'workSummary.titlePartial' : 'workSummary.title')}</h3>

      {work.summary ? (
        <div className="mt-2">
          <MarkdownContent
            ref={contentRef}
            id={contentId}
            className={cn(
              'overflow-hidden prose-pre:overflow-x-auto [&_img]:h-auto [&_img]:max-w-full',
              !expanded && overflows && 'max-h-[200px] [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'
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
      )}

      <ul className="mt-3 space-y-1 text-sm text-foreground">
        <li>{reviewText}</li>
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
          <h4 className="text-xs font-medium text-(--nav-label-color)">{t('workSummary.changes.heading')}</h4>
          <p className="mt-1 text-sm text-foreground">
            {t('workSummary.changes.summary', { count: changes.files.length, additions: changes.additions, deletions: changes.deletions })}
            {changes.commitCount ? `, ${t('workSummary.changes.commits', { count: changes.commitCount })}` : ''}
          </p>
          {shown.length > 0 && (
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

      {effortParts.length > 0 && (
        <p className="mt-3 text-xs text-(--nav-label-color) wrap-anywhere">{effortParts.join(' · ')}</p>
      )}
    </section>
  );
}
