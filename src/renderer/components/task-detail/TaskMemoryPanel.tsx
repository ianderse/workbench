import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '../../../shared/types';
import { Button } from '../ui/button';
import { MemorySourceLink, ProjectMemoryDialog } from '../memory/ProjectMemoryDialog';
import { useProjectMemoryStore } from '../../stores/project-memory-store';

/** Saved prompt receipts, not an assertion that the worker relied on the context. */
export function TaskMemoryPanel({ task }: { task: Task }) {
  const { t } = useTranslation('memory');
  const packets = useProjectMemoryStore((state) => state.contexts[`${task.projectId}:${task.id}`]);
  const requiresRestart = useProjectMemoryStore((state) => state.requiresRestart);
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const available = typeof window.electronAPI.getTaskMemoryContext === 'function';
  const refresh = async () => {
    setBusy(true); setError('');
    try { await useProjectMemoryStore.getState().refreshContext(task.projectId, task.id); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (available && !packets) void refresh(); }, [task.projectId, task.id, available]);
  if (!available) return null;
  return (
    <section className="rounded-lg border p-4" aria-label={t('contextTitle')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('contextTitle')}</h3>
        <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>{t('refresh')}</Button><Button size="sm" variant="outline" onClick={() => setManage(true)}>{t('capture')}</Button></div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('contextHelp')}</p>
      {requiresRestart
        ? <p role="alert" className="text-xs text-muted-foreground">{t('restartRequired')}</p>
        : error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {packets?.length === 0 && <p className="mt-2 text-xs text-muted-foreground">{t('noContext')}</p>}
      <div className="mt-2 space-y-2">
        {packets?.slice().reverse().map((packet, index) => <details key={`${packet.at}:${index}`} className="rounded border p-2 text-xs">
          <summary className="cursor-pointer">{t('packet', { phase: packet.phase, count: packet.items.length, tokens: packet.estimatedTokens })} · {new Date(packet.at).toLocaleString()}</summary>
          <div className="mt-2 space-y-3">{packet.items.map((item) => <div key={item.id} className="space-y-1"><p className="font-medium">{item.title} · {t('revision', { revision: item.revision })}</p><p>{t(`verification.${item.verification}`)}</p>{!!item.disputedBy?.length && <p className="text-amber-500">{t('disputed')}</p>}{item.truncated && <p>{t('excerpt')}</p>}<p className="whitespace-pre-wrap break-words">{item.body}</p><MemorySourceLink projectId={task.projectId} source={item.source} /></div>)}</div>
          <details className="mt-2"><summary className="cursor-pointer">{t('exactContext')}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{packet.prompt}</pre></details>
        </details>)}
      </div>
      <ProjectMemoryDialog key={task.projectId + task.id} projectId={task.projectId} taskId={task.specId} open={manage} onOpenChange={setManage} />
    </section>
  );
}
