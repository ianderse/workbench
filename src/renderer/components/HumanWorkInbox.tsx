import { useTranslation } from 'react-i18next';
import type { Task } from '../../shared/types';
import { Button } from './ui/button';
import { groupHumanWorkItems } from '../../shared/utils/human-work';

/** Human-owned work stays visible without occupying an agent execution slot. */
export function HumanWorkInbox({ tasks, onOpen }: { tasks: Task[]; onOpen: (task: Task) => void }) {
  const { t } = useTranslation('tasks');
  const waiting = tasks.filter((task) => task.status === 'human_review' && !task.metadata?.archivedAt && !task.metadata?.humanWork?.approvalOverride && task.metadata?.humanWork?.items.length);
  if (!waiting.length) return null;
  return <section className="space-y-2 rounded border border-warning/50 p-3" aria-label={t('humanWork.inbox')}>
    <h3 className="text-sm font-medium">{t('humanWork.inbox')}</h3>
    {waiting.map((task) => <div key={task.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 text-sm"><div className="min-w-0 space-y-1"><p className="font-medium wrap-anywhere">{task.title}</p><p className="text-xs text-muted-foreground wrap-anywhere">{groupHumanWorkItems(task.metadata!.humanWork!.items).map(([item]) => `${item.owner || t('humanWork.unassigned')}: ${t(`humanWork.status.${item.status}`)}`).join(' · ')}</p></div><Button size="sm" variant="outline" onClick={() => onOpen(task)}>{t('humanWork.open')}</Button></div>)}
  </section>;
}
