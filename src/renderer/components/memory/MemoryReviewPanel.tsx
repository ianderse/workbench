import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/project-store';
import { useProjectMemoryStore } from '../../stores/project-memory-store';
import { Button } from '../ui/button';

/** Persistent review inbox; desktop notifications are only an optional attention signal. */
export function MemoryReviewPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation('memory');
  const enabled = useProjectStore((state) => state.projects.find((project) => project.id === projectId)?.settings.selfImprove === true);
  const entries = useProjectMemoryStore((state) => state.entries[projectId]);
  const requiresRestart = useProjectMemoryStore((state) => state.requiresRestart);
  useEffect(() => {
    if (enabled && !entries && !requiresRestart && typeof window.electronAPI.listProjectMemories === 'function') {
      void useProjectMemoryStore.getState().refresh(projectId).catch(() => { /* Management dialog exposes load errors. */ });
    }
  }, [projectId, enabled, !!entries, requiresRestart]);
  const pending = entries?.filter((entry) => entry.status === 'proposed') ?? [];
  if (!enabled || !pending.length) return null;
  return <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/40 px-3 py-2 text-sm" role="status">
    <p>{t('reviewPanel', { count: pending.length, conflicts: pending.filter((entry) => entry.reviewReason === 'conflict').length })}</p>
    <Button size="sm" variant="outline" onClick={() => window.dispatchEvent(new CustomEvent('open-project-memory', { detail: { projectId } }))}>{t('review')}</Button>
  </div>;
}
