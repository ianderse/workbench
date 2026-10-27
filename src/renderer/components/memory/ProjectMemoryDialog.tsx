import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemoryContent, MemoryKind, MemoryMutation, MemorySource, ProjectMemory } from '../../../shared/types/project-memory';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { useProjectStore } from '../../stores/project-store';
import { useProjectMemoryStore } from '../../stores/project-memory-store';

export function MemorySourceLink({ projectId, source }: { projectId: string; source: MemorySource }) {
  const { t } = useTranslation('memory');
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const show = async () => {
    setExpanded(!expanded);
    if (expanded || preview !== undefined || busy) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.readMemorySource(projectId, source);
      if (!result.success) setError(result.error ?? t('loadFailed'));
      else setPreview(result.data ?? '');
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  return (
    <div className="text-xs">
      <p className="mb-1 whitespace-pre-wrap break-words text-muted-foreground"><span className="font-medium">{t('evidenceSummary')}</span> {source.evidence}</p>
      <button type="button" className="max-w-full break-words text-left text-primary underline underline-offset-2" aria-expanded={expanded} onClick={() => void show()}>
        {t('sourceLink', { type: t(`sourceTypes.${source.type}`), reference: source.reference })}
      </button>
      {source.file && <p className="mt-1 break-all">{t('citation', { file: source.file })}</p>}
      {source.quote && <blockquote className="mt-1 whitespace-pre-wrap break-words border-l pl-2">{source.quote}</blockquote>}
      {source.commit && <p className="mt-1 break-all font-mono">{t('commit', { commit: source.commit })}</p>}
      {expanded && (
        <div className="mt-2 space-y-2 rounded border p-2">
          <p className="text-muted-foreground">{t('sourcePreview')}</p>
          {busy && <p>{t('loading')}</p>}
          {error && <p role="alert" className="text-destructive">{error}</p>}
          {preview !== undefined && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">{preview}</pre>}
        </div>
      )}
    </div>
  );
}

const emptyContent = (taskId?: string): MemoryContent => ({ kind: 'lesson', title: '', body: '', source: { type: taskId ? 'task' : 'user', reference: taskId ?? '', evidence: '' } });

export function ProjectMemoryDialog({ projectId, open, onOpenChange, taskId }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void; taskId?: string }) {
  const { t } = useTranslation('memory');
  const entries = useProjectMemoryStore((state) => state.entries[projectId]);
  const requiresRestart = useProjectMemoryStore((state) => state.requiresRestart);
  const projectEnabled = useProjectStore((state) => state.projects.find((project) => project.id === projectId)?.settings.selfImprove === true);
  const enabled = projectEnabled && !requiresRestart;
  const [content, setContent] = useState<MemoryContent>(() => emptyContent(taskId));
  const [editing, setEditing] = useState<ProjectMemory>();
  const [supersedes, setSupersedes] = useState<string>();
  const [showInactive, setShowInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Kept across uncertain responses, so Retry cannot make another proposal.
  const request = useRef(crypto.randomUUID());
  const refresh = async () => {
    setBusy(true); setError('');
    try { await useProjectMemoryStore.getState().refresh(projectId); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (open && !entries) void refresh(); }, [open, projectId]);
  const reset = () => { setEditing(undefined); setSupersedes(undefined); setContent(emptyContent(taskId)); request.current = crypto.randomUUID(); };
  // A dialog remounted for another project must never carry a draft across the boundary.
  useEffect(() => { reset(); setError(''); }, [projectId, taskId]);
  const change = (next: MemoryContent) => { setContent(next); request.current = crypto.randomUUID(); };
  const mutate = async (mutation: MemoryMutation, clearDraft = false) => {
    setBusy(true); setError('');
    try {
      const result = await window.electronAPI.mutateProjectMemory(projectId, mutation);
      if (!result.success) throw new Error(result.error ?? t('saveFailed'));
      if (clearDraft) reset();
      await useProjectMemoryStore.getState().refresh(projectId);
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const save = () => void mutate(editing
    ? { action: 'revise', id: editing.id, expectedRevision: editing.revision, content }
    : { action: 'propose', requestId: request.current, content, ...(supersedes ? { supersedes } : {}) }, true);
  const valid = !!(content.title.trim() && content.body.trim() && content.source.reference.trim() && content.source.evidence.trim());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="mt-3 min-h-0 space-y-4 overflow-y-auto pr-1">
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>{t('refresh')}</Button>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />{t('showInactive')}</label>
          </div>
          {!projectEnabled && <p className="text-sm text-muted-foreground">{t('disabled')}</p>}
          {requiresRestart
            ? <p role="alert" className="text-sm text-muted-foreground">{t('restartRequired')}</p>
            : error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="space-y-3">
            {entries?.filter((entry) => showInactive || entry.status === 'active' || entry.status === 'proposed').sort((a, b) => Number(b.status === 'proposed') - Number(a.status === 'proposed')).map((entry) => (
              <article key={entry.id} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{entry.title}</h3>
                  <span className="text-xs text-muted-foreground">{t(`kinds.${entry.kind}`)} · {t(`statuses.${entry.status}`)} · {t('revision', { revision: entry.revision })}</span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{entry.body}</p>
                {entry.status === 'proposed' && <p className="text-xs text-muted-foreground">{t('proposalRecallHelp')}</p>}
                <p className="text-xs text-muted-foreground">{t(`verification.${entry.verification}`)} · {new Date(entry.at).toLocaleString()}</p>
                {entry.status === 'proposed' && entry.reviewReason && <p className="text-xs text-amber-500">{t(`reviewReasons.${entry.reviewReason}`)}</p>}
                {entry.status === 'proposed' && entry.conflictsWith?.map((id) => entries.find((item) => item.id === id && item.status === 'active')).filter((item): item is ProjectMemory => !!item).map((conflict) => <div key={conflict.id} className="space-y-1 rounded border border-amber-500/40 p-2 text-xs"><p>{t('conflictWith')} {conflict.title}</p><p className="whitespace-pre-wrap break-words">{conflict.body}</p><MemorySourceLink projectId={projectId} source={conflict.source} /></div>)}
                {entry.supersedes && <p className="break-all text-xs">{t('replaces', { title: entries.find((item) => item.id === entry.supersedes)?.title ?? entry.supersedes })}</p>}
                <MemorySourceLink key={`${entry.id}:${entry.revision}`} projectId={projectId} source={entry.source} />
                {entry.status !== 'deleted' && (
                  <div className="flex flex-wrap gap-2">
                    {entry.status === 'proposed' && !entry.conflictsWith?.some((id) => entries.some((item) => item.id === id && item.status === 'active')) && <Button size="sm" disabled={busy || !enabled} onClick={() => void mutate({ action: 'accept', id: entry.id, expectedRevision: entry.revision })}>{t('accept')}</Button>}
                    {entry.status === 'proposed' && !!entry.conflictsWith?.length && entry.conflictsWith.every((id) => entries.some((item) => item.id === id && item.status === 'active')) && <><Button size="sm" disabled={busy || !enabled} onClick={() => void mutate({ action: 'resolve', id: entry.id, expectedRevision: entry.revision, conflicts: entry.conflictsWith!.map((id) => ({ id, revision: entries.find((item) => item.id === id)!.revision })) })}>{t('useNew')}</Button><Button size="sm" variant="outline" disabled={busy || !enabled} onClick={() => void mutate({ action: 'delete', id: entry.id, expectedRevision: entry.revision })}>{t('keepExisting')}</Button></>}
                    <Button size="sm" variant="outline" disabled={busy || !enabled} onClick={() => { setEditing(entry); setSupersedes(undefined); change({ kind: entry.kind, title: entry.title, body: entry.body, source: entry.source }); }}>{t('correct')}</Button>
                    {entry.status === 'active' && <Button size="sm" variant="outline" disabled={busy || !enabled} onClick={() => { setEditing(undefined); setSupersedes(entry.id); change({ ...emptyContent(taskId), kind: entry.kind, title: entry.title }); }}>{t('replace')}</Button>}
                    {entry.status === 'active' && <Button size="sm" variant="ghost" disabled={busy || !enabled} onClick={() => void mutate({ action: 'obsolete', id: entry.id, expectedRevision: entry.revision })}>{t('obsolete')}</Button>}
                    <Button size="sm" variant="ghost" disabled={busy || !enabled} onClick={() => void mutate({ action: 'delete', id: entry.id, expectedRevision: entry.revision })}>{t(entry.status === 'proposed' ? 'dismiss' : 'remove')}</Button>
                  </div>
                )}
                {entry.history.length > 0 && <details className="text-xs"><summary className="cursor-pointer">{t('history', { count: entry.history.length })}</summary><ol className="mt-2 space-y-2">{entry.history.map((revision) => <li key={revision.revision} className="border-l pl-2"><p>{t('revision', { revision: revision.revision })} · {t(`statuses.${revision.status}`)} · {new Date(revision.at).toLocaleString()}</p><p className="font-medium">{revision.title}</p><p className="whitespace-pre-wrap break-words">{revision.body}</p><MemorySourceLink projectId={projectId} source={revision.source} /></li>)}</ol></details>}
              </article>
            ))}
            {entries?.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
          </div>
          {!requiresRestart && <form className="space-y-3 rounded-lg border p-3" onSubmit={(event) => { event.preventDefault(); if (valid && !busy && enabled) save(); }}>
            <h3 className="text-sm font-medium">{editing ? t('correctTitle') : supersedes ? t('replaceTitle') : t('newTitle')}</h3>
            <p className="text-xs text-muted-foreground">{t('proposalHelp')}</p>
            <label className="block space-y-1 text-xs">{t('kind')}<select className="block w-full rounded border bg-background p-2 text-sm" value={content.kind} onChange={(event) => change({ ...content, kind: event.target.value as MemoryKind })}>{(['decision', 'lesson', 'procedure', 'preference'] as const).map((kind) => <option key={kind} value={kind}>{t(`kinds.${kind}`)}</option>)}</select></label>
            <p className="text-xs text-muted-foreground">{t(`kindHelp.${content.kind}`)}</p>
            <label className="block space-y-1 text-xs">{t('entryTitle')}<Input maxLength={160} value={content.title} onChange={(event) => change({ ...content, title: event.target.value })} /></label>
            <label className="block space-y-1 text-xs">{t('body')}<textarea className="block w-full rounded border bg-background p-2 text-sm" maxLength={8000} rows={3} value={content.body} onChange={(event) => change({ ...content, body: event.target.value })} /></label>
            <label className="block space-y-1 text-xs">{t('sourceType')}<select className="block w-full rounded border bg-background p-2 text-sm" value={content.source.type} onChange={(event) => change({ ...content, source: { ...content.source, type: event.target.value as MemorySource['type'] } })}>{(['task', 'file', 'user'] as const).map((type) => <option key={type} value={type}>{t(`sourceTypes.${type}`)}</option>)}</select></label>
            <label className="block space-y-1 text-xs">{t('reference')}<Input maxLength={1000} value={content.source.reference} onChange={(event) => change({ ...content, source: { ...content.source, reference: event.target.value } })} /></label>
            <label className="block space-y-1 text-xs">{t('evidence')}<textarea className="block w-full rounded border bg-background p-2 text-sm" maxLength={4000} rows={3} value={content.source.evidence} onChange={(event) => change({ ...content, source: { ...content.source, evidence: event.target.value } })} /></label>
            <label className="block space-y-1 text-xs">{t('commitLabel')}<Input maxLength={64} value={content.source.commit ?? ''} onChange={(event) => change({ ...content, source: { ...content.source, commit: event.target.value } })} /></label>
            <div className="flex gap-2"><Button type="submit" size="sm" disabled={!enabled || busy || !valid}>{t('saveProposal')}</Button>{(editing || supersedes) && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={reset}>{t('cancel')}</Button>}</div>
          </form>}
          <p className="text-xs text-muted-foreground">{t('retention')}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
