/**
 * TaskBreakdownReview - Review step of "Break into tasks": the proposed tasks with a checkbox,
 * editable title and description, and which tasks each one waits for.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Link2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Switch } from '../ui/switch';
import { cn } from '../../lib/utils';
import type { BreakdownTask, OpenTicketRef } from '../../../shared/types/task-breakdown';
import { ticketNumberLabel } from '../../../shared/utils/open-tickets';
import type { AgentOverride } from '../../../shared/types/task';
import { TaskAgentPicker } from './TaskAgentPicker';

export interface BreakdownItem extends BreakdownTask {
  included: boolean;
  /** Model pinned on the task (unset = triage decides) */
  agentOverride?: AgentOverride;
}

/**
 * For each included task, the included tasks it waits for. A task that waited for an unchecked
 * task inherits that task's own dependencies, so the order still holds without it.
 */
export function effectiveDependencies(items: readonly BreakdownItem[]): Record<string, string[]> {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const resolve = (key: string, seen: Set<string>): string[] => {
    const item = byKey.get(key);
    if (!item || seen.has(key)) return [];
    seen.add(key);
    if (item.included) return [key];
    return item.dependsOn.flatMap((d) => resolve(d, seen));
  };
  const result: Record<string, string[]> = {};
  for (const item of items) {
    if (!item.included) continue;
    const deps = item.dependsOn.flatMap((d) => resolve(d, new Set([item.key])));
    result[item.key] = Array.from(new Set(deps)).filter((d) => d !== item.key);
  }
  return result;
}

/**
 * For each included task, the existing open tickets it waits for: its own, plus those of unchecked
 * tasks it waited for (they are not created, so what they waited for still holds).
 */
export function effectiveExistingDependencies(items: readonly BreakdownItem[]): Record<string, string[]> {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const collect = (key: string, seen: Set<string>, out: Set<string>): void => {
    const item = byKey.get(key);
    if (!item || seen.has(key)) return;
    seen.add(key);
    for (const id of item.dependsOnExisting ?? []) out.add(id);
    if (!item.included) for (const d of item.dependsOn) collect(d, seen, out);
  };
  const result: Record<string, string[]> = {};
  for (const item of items) {
    if (!item.included) continue;
    const out = new Set<string>(item.dependsOnExisting ?? []);
    const seen = new Set<string>([item.key]);
    for (const d of item.dependsOn) collect(d, seen, out);
    result[item.key] = Array.from(out);
  }
  return result;
}

interface TaskBreakdownReviewProps {
  items: BreakdownItem[];
  /** Open tickets a task can wait for */
  openTickets?: OpenTicketRef[];
  onItemsChange: (items: BreakdownItem[]) => void;
  queue: boolean;
  onQueueChange: (queue: boolean) => void;
  disabled?: boolean;
  error?: string | null;
}

export function TaskBreakdownReview({ items, openTickets = [], onItemsChange, queue, onQueueChange, disabled = false, error }: TaskBreakdownReviewProps) {
  const { t } = useTranslation(['tasks']);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const dependencies = effectiveDependencies(items);
  const existingDependencies = effectiveExistingDependencies(items);
  const titleOf = (key: string) => items.find((i) => i.key === key)?.title || key;

  const update = (key: string, patch: Partial<BreakdownItem>) =>
    onItemsChange(items.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {items.map((item) => {
          const isOpen = expanded.has(item.key);
          const existing = existingDependencies[item.key] ?? [];
          const after = [...existing.map(ticketNumberLabel), ...(dependencies[item.key] ?? []).map(titleOf)];
          return (
            <li key={item.key} className={cn('rounded-lg border border-border px-3 py-2.5', !item.included && 'opacity-60')}>
              <div className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-primary"
                  checked={item.included}
                  disabled={disabled}
                  onChange={(e) => update(item.key, { included: e.target.checked })}
                  aria-label={t('tasks:breakdown.taskCheckbox', { title: item.title })}
                />
                <input
                  type="text"
                  value={item.title}
                  disabled={disabled}
                  onChange={(e) => update(item.key, { title: e.target.value })}
                  aria-label={t('tasks:breakdown.titleLabel')}
                  className="min-w-0 flex-1 bg-transparent text-sm font-bold text-foreground focus:outline-none disabled:cursor-not-allowed"
                />
                <button
                  type="button"
                  onClick={() => toggleExpanded(item.key)}
                  aria-expanded={isOpen}
                  aria-label={isOpen ? t('tasks:breakdown.hideDescription') : t('tasks:breakdown.showDescription')}
                  title={isOpen ? t('tasks:breakdown.hideDescription') : t('tasks:breakdown.showDescription')}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-nav-hover hover:text-foreground"
                >
                  <ChevronRight className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-90')} strokeWidth={1.75} />
                </button>
              </div>
              {item.included && (
                <div className="mt-1.5 flex items-center justify-between gap-2 pl-6.5">
                  <span className="text-xs text-(--nav-label-color)">{t('tasks:agentPicker.title')}</span>
                  <TaskAgentPicker
                    compact
                    value={item.agentOverride}
                    onChange={(agentOverride) => update(item.key, { agentOverride })}
                    disabled={disabled}
                    idPrefix={`breakdown-${item.key}`}
                  />
                </div>
              )}
              {item.included && (after.length > 0 || openTickets.length > 0) && (
                <div className="mt-1 flex items-start justify-between gap-2 pl-6.5">
                  <p className="min-w-0 text-xs text-(--nav-label-color) wrap-anywhere">
                    {after.length > 0 ? t('tasks:breakdown.after', { titles: after.join(', ') }) : ''}
                  </p>
                  {openTickets.length > 0 && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={t('tasks:breakdown.existingDependencies')}
                          title={t('tasks:breakdown.existingDependencies')}
                          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-nav-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                        >
                          <Link2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                          {item.dependsOnExisting?.length ? t('tasks:breakdown.waitForTickets', { count: item.dependsOnExisting.length }) : t('tasks:breakdown.waitForTicketsNone')}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-80 p-2">
                        <p className="px-1 pb-1 text-xs text-(--nav-label-color)">{t('tasks:breakdown.existingDependenciesHint')}</p>
                        <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                          {openTickets.map((ticket) => {
                            const checked = item.dependsOnExisting?.includes(ticket.id) ?? false;
                            return (
                              <li key={ticket.id}>
                                <label className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-sm hover:bg-nav-hover">
                                  <input
                                    type="checkbox"
                                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                                    checked={checked}
                                    onChange={(e) => {
                                      const current = item.dependsOnExisting ?? [];
                                      update(item.key, {
                                        dependsOnExisting: e.target.checked
                                          ? [...current, ticket.id]
                                          : current.filter((id) => id !== ticket.id),
                                      });
                                    }}
                                  />
                                  <span className="min-w-0 wrap-anywhere">
                                    <span className="text-xs text-(--nav-label-color)">{ticketNumberLabel(ticket.id)}</span>{' '}
                                    {ticket.title}
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              )}
              {isOpen && (
                <textarea
                  value={item.description}
                  disabled={disabled}
                  rows={6}
                  onChange={(e) => update(item.key, { description: e.target.value })}
                  aria-label={t('tasks:breakdown.descriptionLabel')}
                  className="field-border mt-2 block w-full resize-y rounded-lg border border-border bg-transparent p-2 text-sm leading-relaxed text-foreground focus:outline-none"
                />
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-between gap-4 rounded-lg px-1 py-1">
        <div className="min-w-0">
          <div className="text-sm text-foreground">{t('tasks:breakdown.queueLabel')}</div>
          <div className="text-xs text-(--nav-label-color)">{t('tasks:breakdown.queueDescription')}</div>
        </div>
        <Switch checked={queue} onCheckedChange={onQueueChange} disabled={disabled} aria-label={t('tasks:breakdown.queueLabel')} />
      </div>

      {error && <p role="alert" className="text-sm text-destructive wrap-anywhere">{error}</p>}
    </div>
  );
}
