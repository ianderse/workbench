import { useState, useMemo } from 'react';
import {
  Terminal,
  Loader2,
  Pencil,
  FileCode,
  ChevronDown,
  ChevronRight,
  FileText,
  Search,
  FolderSearch,
  Wrench,
  Info
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../ui/badge';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../ui/collapsible';
import { cn } from '../../lib/utils';
import { formatDateTime } from '../../../shared/utils/format-date-time';
import { useSettingsStore } from '../../stores/settings-store';
import { summarizeLogPhase, formatCostUsd, formatDurationMs } from '../../../shared/utils/claude-run';
import type { TaskLogs, TaskLogPhase, TaskPhaseLog, TaskLogEntry, TaskStatus } from '../../../shared/types';
import type { ClaudeRunPhase } from '../../../shared/types/claude-code';

// Neutral chip for tool activity (no per-tool colors)
const TOOL_CHIP_CLASS = 'text-muted-foreground bg-segment-track';

interface TaskLogsProps {
  /** The run's step logs */
  phaseLogs: TaskLogs | null;
  /** The run's steps, for the time and cost in the header */
  runPhases?: ClaudeRunPhase[];
  /** Lines of a task that ran before step logs existed */
  legacyLogs?: string[];
  /** The run is over, so a step still marked active simply never got its end entry */
  isSettled: boolean;
  /** Header label; the current run uses the default "Logs" */
  title?: string;
  /**
   * Section heading above the dropdown, for when this run needs separating from the others.
   * It hides with the rest when the run has nothing to show.
   */
  heading?: { title: string; description: string };
  isLoadingLogs?: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}

const LOG_PHASES: TaskLogPhase[] = ['planning', 'coding', 'validation'];

/** A run whose task is in one of these states is over, however its last step was left */
export function isTaskRunSettled(status: TaskStatus): boolean {
  return status === 'human_review' || status === 'done' || status === 'pr_created' || status === 'error';
}

/**
 * One run's logs as a collapsible section: every step's entries (triage and plan,
 * implementation, validation) in one list, with the steps' total time and cost in the header.
 * Used for the task's current run ("Logs") and for each run it was started over from.
 */
export function TaskLogs({
  phaseLogs,
  runPhases,
  legacyLogs: legacyTaskLogs,
  isSettled: isTaskSettled,
  title,
  heading,
  isLoadingLogs,
  isExpanded,
  onToggle
}: TaskLogsProps) {
  const { t } = useTranslation(['tasks']);
  const logOrder = useSettingsStore((s) => s.settings.logOrder);

  const { items, entryCount, status } = useMemo(() => {
    const all: LogItem[] = [];
    let count = 0;
    let lastStatus: string | undefined;
    for (const phase of LOG_PHASES) {
      const phaseLog = phaseLogs?.phases[phase];
      if (!phaseLog || phaseLog.entries.length === 0) continue;
      count += phaseLog.entries.length;
      const phaseStatus = getPhaseStatus(phaseLog, isTaskSettled);
      lastStatus = phaseStatus;
      // A failed step ends with a phase_end entry that holds the error: show it as an error
      const entries = phaseStatus === 'failed'
        ? phaseLog.entries.map((entry, i) =>
            i === phaseLog.entries.length - 1 && entry.type === 'phase_end' ? { ...entry, type: 'error' as const } : entry)
        : phaseLog.entries;
      for (const item of groupToolCalls(entries)) {
        all.push(item.kind === 'tool' ? { ...item, running: !item.end && phaseStatus === 'active' } : item);
      }
    }
    // One timeline across the steps (a rerun's steps follow the earlier run's)
    const time = (item: LogItem) =>
      Date.parse((item.kind === 'tool' ? (item.start ?? item.end)! : item.entry).timestamp) || 0;
    all.sort((a, b) => time(a) - time(b));
    return {
      items: logOrder === 'reverse-chronological' ? all.reverse() : all,
      entryCount: count,
      status: lastStatus
    };
  }, [phaseLogs, isTaskSettled, logOrder]);

  // Total time and cost of the run's steps
  const { durationMs, costUsd } = useMemo(() => {
    let duration: number | undefined;
    let cost: number | undefined;
    for (const phase of LOG_PHASES) {
      const summary = summarizeLogPhase(runPhases, phase);
      if (summary.durationMs !== undefined) duration = (duration ?? 0) + summary.durationMs;
      if (summary.costUsd !== undefined) cost = (cost ?? 0) + summary.costUsd;
    }
    return { durationMs: duration, costUsd: cost };
  }, [runPhases]);

  const legacyLogs = !phaseLogs && legacyTaskLogs && legacyTaskLogs.length > 0 ? legacyTaskLogs : null;
  const summaryParts = [
    entryCount > 0 ? t('tasks:logs.entries', { count: entryCount }) : null,
    durationMs !== undefined ? formatDurationMs(durationMs) : null,
    costUsd !== undefined ? formatCostUsd(costUsd) : null
  ].filter((part): part is string => !!part);

  // Shown once the task has something to show
  if (items.length === 0 && !legacyLogs) return null;

  const dropdown = (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        {/* Ghost button with a trailing chevron, like the settings dropdown triggers */}
        <button
          type="button"
          className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left outline-none transition-colors hover:bg-nav-hover focus-visible:shadow-(--shadow-focus) data-[state=open]:bg-nav-hover"
        >
          <span className="text-sm text-foreground">{title ?? t('tasks:logs.title')}</span>
          {status === 'failed' && <span className="text-xs text-destructive">{t('tasks:execution.phases.failed')}</span>}
          {status === 'stopped' && <span className="text-xs text-(--nav-label-color)">{t('tasks:logs.stopped')}</span>}
          {summaryParts.length > 0 && (
            <span className="text-xs text-(--nav-label-color) tabular-nums">{summaryParts.join(' · ')}</span>
          )}
          {isLoadingLogs && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <ChevronDown
            className={cn(
              'ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
              isExpanded && 'rotate-180'
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-1 py-2">
          {items.length > 0 ? (
            // The position is part of the key: several tool calls of one reply share its timestamp
            // and tool name (OMP batches calls), and the log only grows, so positions are stable
            items.map((item, index) =>
              item.kind === 'tool' ? (
                <ToolCallRow
                  key={`${index}-${(item.start ?? item.end)!.timestamp}-tool-${(item.start ?? item.end)!.tool_name}`}
                  start={item.start}
                  end={item.end}
                  isRunning={!!item.running}
                />
              ) : (
                <LogEntry key={`${index}-${item.entry.timestamp}-${item.entry.type}`} entry={item.entry} />
              )
            )
          ) : (
            // Older tasks without step logs
            <pre className="whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">{legacyLogs!.join('\n')}</pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );

  if (!heading) return dropdown;
  return (
    <div>
      <h3 className="mb-1 text-sm text-foreground">{heading.title}</h3>
      <p className="mb-3 text-sm text-(--nav-label-color)">{heading.description}</p>
      {dropdown}
    </div>
  );
}

/** A step's log status; logs written before steps could be "stopped" recorded a stop as failed */
function getPhaseStatus(phaseLog: TaskPhaseLog, isTaskSettled: boolean): string {
  const last = phaseLog.entries.at(-1);
  if (phaseLog.status === 'failed' && last?.type === 'phase_end' && last.content === 'Stopped') return 'stopped';
  if (phaseLog.status === 'active' && isTaskSettled) return 'completed';
  return phaseLog.status;
}

type LogItem =
  | { kind: 'entry'; entry: TaskLogEntry }
  | { kind: 'tool'; start?: TaskLogEntry; end?: TaskLogEntry; running?: boolean };

/**
 * Merge each tool call's tool_start and tool_end entries into one item. Newer logs pair them by
 * tool_use_id; older ones match an end to the oldest open start of the same tool.
 */
function groupToolCalls(entries: TaskLogEntry[]): LogItem[] {
  const items: LogItem[] = [];
  const openById = new Map<string, Extract<LogItem, { kind: 'tool' }>>();
  const openByName = new Map<string, Extract<LogItem, { kind: 'tool' }>[]>();
  for (const entry of entries) {
    if (entry.type === 'tool_start' && entry.tool_name) {
      const item: Extract<LogItem, { kind: 'tool' }> = { kind: 'tool', start: entry };
      items.push(item);
      if (entry.tool_use_id) openById.set(entry.tool_use_id, item);
      else openByName.set(entry.tool_name, [...(openByName.get(entry.tool_name) ?? []), item]);
    } else if (entry.type === 'tool_end' && entry.tool_name) {
      let item = entry.tool_use_id ? openById.get(entry.tool_use_id) : undefined;
      if (item) {
        openById.delete(entry.tool_use_id!);
      } else {
        const queue = openByName.get(entry.tool_name);
        item = queue?.shift();
      }
      if (item) item.end = entry;
      else items.push({ kind: 'tool', end: entry });
    } else {
      items.push({ kind: 'entry', entry });
    }
  }
  return items;
}

function useToolInfo() {
  const { t } = useTranslation(['tasks']);
  return (toolName: string) => {
    switch (toolName) {
      case 'Read':
        return { icon: FileText, label: t('tasks:logs.tools.reading') };
      case 'Glob':
        return { icon: FolderSearch, label: t('tasks:logs.tools.searchingFiles') };
      case 'Grep':
        return { icon: Search, label: t('tasks:logs.tools.searchingCode') };
      case 'Edit':
        return { icon: Pencil, label: t('tasks:logs.tools.editing') };
      case 'Write':
        return { icon: FileCode, label: t('tasks:logs.tools.writing') };
      case 'Bash':
        return { icon: Terminal, label: t('tasks:logs.tools.running') };
      default:
        return { icon: Wrench, label: toolName };
    }
  };
}

/** One tool call: a row (tool, input, status) that expands to the call's output when it has one */
function ToolCallRow({ start, end, isRunning }: { start?: TaskLogEntry; end?: TaskLogEntry; isRunning: boolean }) {
  const { t } = useTranslation(['tasks']);
  const getToolInfo = useToolInfo();
  const [isExpanded, setIsExpanded] = useState(false);
  const toolName = (start ?? end)!.tool_name!;
  const { icon: Icon, label } = getToolInfo(toolName);
  const failed = !!end && end.content.endsWith(' failed');
  const output = end?.detail;
  const subphase = start?.subphase ?? end?.subphase;

  const row = (
    <>
      {isRunning ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <Icon className="h-3 w-3 shrink-0" />}
      <span className="shrink-0 font-medium text-foreground">{label}</span>
      {start?.tool_input && (
        <span className="min-w-0 truncate" title={start.tool_input}>
          {start.tool_input}
        </span>
      )}
      {subphase && (
        <Badge variant="outline" className="ml-1 border-muted-foreground/30 px-1 py-0 text-[9px] text-muted-foreground">
          {subphase}
        </Badge>
      )}
      {failed && <span className="shrink-0 text-destructive">{t('tasks:execution.phases.failed')}</span>}
      {output && (
        <ChevronDown
          className={cn('ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200', isExpanded && 'rotate-180')}
        />
      )}
    </>
  );
  const rowClass = cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs', TOOL_CHIP_CLASS);

  if (!output) return <div className={rowClass}>{row}</div>;
  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(rowClass, 'outline-none transition-colors hover:bg-nav-hover focus-visible:shadow-(--shadow-focus)')}
        >
          {row}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 overflow-x-auto rounded-lg border border-border p-2">
          <pre
            className={cn(
              'max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px]',
              failed ? 'text-destructive/80' : 'text-muted-foreground'
            )}
          >
            {output}
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Log Entry Component
interface LogEntryProps {
  entry: TaskLogEntry;
}

function LogEntry({ entry }: LogEntryProps) {
  const { t } = useTranslation(['tasks']);
  const [isExpanded, setIsExpanded] = useState(false);
  const hasDetail = Boolean(entry.detail);

  const SubphaseBadge = () => {
    if (!entry.subphase) return null;
    return (
      <Badge variant="outline" className="text-[9px] px-1 py-0 ml-1 text-muted-foreground border-muted-foreground/30">
        {entry.subphase}
      </Badge>
    );
  };

  if (entry.type === 'error') {
    return (
      <div className="flex flex-col">
        <div className="flex items-start gap-2 text-xs text-destructive px-2 py-1">
          <span className="break-words flex-1">{entry.content}</span>
          <SubphaseBadge />
          {hasDetail && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className={cn(
                'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded shrink-0',
                'text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors',
                isExpanded && 'bg-secondary/50'
              )}
            >
              {isExpanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
            </button>
          )}
        </div>
        {hasDetail && isExpanded && (
          <div className="mt-1.5 ml-4 p-2 rounded-lg border border-border overflow-x-auto">
            <pre className="text-[10px] text-destructive/80 whitespace-pre-wrap break-words font-mono max-h-[300px] overflow-y-auto">
              {entry.detail}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (entry.type === 'success') {
    return (
      <div className="flex items-start gap-2 text-xs text-foreground px-2 py-1">
        <span className="break-words flex-1">{entry.content}</span>
        <SubphaseBadge />
      </div>
    );
  }

  if (entry.type === 'info') {
    return (
      <div className="flex items-start gap-2 text-xs text-muted-foreground px-2 py-1">
        <Info className="h-3 w-3 mt-0.5 shrink-0" />
        <span className="break-words flex-1">{entry.content}</span>
        <SubphaseBadge />
      </div>
    );
  }

  // Default text entry
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-2 text-xs text-muted-foreground py-0.5">
        <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
          {formatDateTime(entry.timestamp)}
        </span>
        <span className="break-words whitespace-pre-wrap flex-1">{entry.content}</span>
        <SubphaseBadge />
        {hasDetail && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className={cn(
              'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded shrink-0',
              'text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors',
              isExpanded && 'bg-secondary/50'
            )}
          >
            {isExpanded ? (
              <>
                <ChevronDown className="h-2.5 w-2.5" />
                <span>{t('tasks:logs.less')}</span>
              </>
            ) : (
              <>
                <ChevronRight className="h-2.5 w-2.5" />
                <span>{t('tasks:logs.more')}</span>
              </>
            )}
          </button>
        )}
      </div>
      {hasDetail && isExpanded && (
        <div className="mt-1.5 ml-12 p-2 rounded-lg border border-border overflow-x-auto">
          <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words font-mono max-h-[300px] overflow-y-auto">
            {entry.detail}
          </pre>
        </div>
      )}
    </div>
  );
}
