import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { memoryHasConflict, memoryNeedsDecision } from '../../../shared/utils/project-memory-review';
import { useProjectStore } from '../../stores/project-store';
import { useProjectMemoryStore } from '../../stores/project-memory-store';
import { Button } from '../ui/button';

/** Persistent attention is reserved for a conflict or an explicit user-authored proposal. */
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
  const pending = entries?.filter((entry) => memoryNeedsDecision(entry, entries)) ?? [];
  if (!enabled || !pending.length) return null;
  return <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/40 px-3 py-2 text-sm" role="status">
    <p>{t('reviewPanel', { count: pending.length, conflicts: pending.filter((entry) => memoryHasConflict(entry, entries ?? [])).length })}</p>
    <Button size="sm" variant="outline" onClick={() => window.dispatchEvent(new CustomEvent('open-project-memory', { detail: { projectId } }))}>{t('review')}</Button>
  </div>;
}
