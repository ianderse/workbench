import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '../../../../shared/types';
import type { HumanWorkItem, HumanWorkMutation } from '../../../../shared/types/human-work';
import type { ReviewRoundFinding } from '../../../../shared/types/claude-code';
import { humanFindingKey, isHumanApprovalOverride } from '../../../../shared/utils/human-work';
import { useTaskStore } from '../../../stores/task-store';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';

type HumanDraft = Pick<HumanWorkItem, 'owner' | 'status' | 'response' | 'evidence'>;
const fieldsOf = ({ owner, status, response, evidence }: HumanWorkItem): HumanDraft => ({ owner, status, response, evidence });

function HumanAction({ item, draft, change, save, disabled }: { item: HumanWorkItem; draft: HumanDraft; change: (fields: HumanDraft) => void; save: (fields: Omit<Extract<HumanWorkMutation, { action: 'update' }>, 'action' | 'expectedRevision'>) => void; disabled: boolean }) {
  const { t } = useTranslation('tasks');
  const { owner, status, response, evidence } = draft;
  return <article className="space-y-3 rounded border p-3">
    <p className="text-sm font-medium whitespace-pre-wrap wrap-anywhere">{item.finding.description}</p>
    {item.finding.file && <p className="break-all font-mono text-xs">{item.finding.file}{item.finding.line ? `:${item.finding.line}` : ''}</p>}
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save({ id: item.id, owner, status, response, evidence }); }}>
      <label className="block space-y-1 text-xs">{t('humanWork.owner')}<Input maxLength={160} value={owner} onChange={(event) => change({ ...draft, owner: event.target.value })} disabled={disabled} /></label>
      <label className="block space-y-1 text-xs">{t('humanWork.statusLabel')}<select className="block w-full rounded border bg-background p-2 text-sm" value={status} onChange={(event) => change({ ...draft, status: event.target.value as HumanWorkItem['status'] })} disabled={disabled}>{(['open', 'in_progress', 'submitted'] as const).map((value) => <option key={value} value={value}>{t(`humanWork.status.${value}`)}</option>)}</select></label>
      <label className="block space-y-1 text-xs">{t('humanWork.response')}<textarea className="block w-full rounded border bg-background p-2 text-sm" rows={3} maxLength={8000} value={response} onChange={(event) => change({ ...draft, response: event.target.value })} disabled={disabled} /></label>
      <label className="block space-y-1 text-xs">{t('humanWork.evidence')}<textarea className="block w-full rounded border bg-background p-2 text-sm" rows={2} maxLength={4000} value={evidence} onChange={(event) => change({ ...draft, evidence: event.target.value })} disabled={disabled} /></label>
      <Button type="submit" size="sm" variant="outline" disabled={disabled || (status === 'submitted' && !(owner.trim() && response.trim() && evidence.trim()))}>{t('humanWork.save')}</Button>
    </form>
    <p className="text-xs text-muted-foreground">{t('humanWork.recorded', { at: new Date(item.at).toLocaleString(), revision: item.revision })}</p>
    {!!item.history.length && <details className="text-xs"><summary>{t('humanWork.history')}</summary>{item.history.slice().reverse().map((entry) => <div key={entry.revision} className="mt-2 space-y-1 border-l pl-2"><p>{entry.owner || t('humanWork.unassigned')} · {t(`humanWork.status.${entry.status}`)} · {new Date(entry.at).toLocaleString()}</p><p className="whitespace-pre-wrap wrap-anywhere">{entry.response}</p><p className="whitespace-pre-wrap wrap-anywhere">{entry.evidence}</p></div>)}</details>}
  </article>;
}

export function HumanWorkPanel({ task, findings }: { task: Task; findings: ReviewRoundFinding[] }) {
  const { t } = useTranslation('tasks');
  const cached = useTaskStore((state) => state.tasks.find((entry) => entry.id === task.id && entry.projectId === task.projectId));
  const stream = (cached ?? task).metadata?.humanWork;
  const overrideActive = isHumanApprovalOverride(stream?.approvalOverride);
  const [showOverride, setShowOverride] = useState(false);
  const latestOwner = stream?.items.slice().reverse().find((item) => item.owner.trim());
  const [approver, setApprover] = useState(stream?.approvalOverride?.approver ?? latestOwner?.owner ?? '');
  const [overrideReason, setOverrideReason] = useState(stream?.approvalOverride?.reason ?? '');
  const [drafts, setDrafts] = useState<Record<string, { revision: number; fields: HumanDraft }>>({});
  const draftFor = (item: HumanWorkItem) => drafts[item.id]?.revision === item.revision ? drafts[item.id].fields : fieldsOf(item);
  const edited = (item: HumanWorkItem) => JSON.stringify(draftFor(item)) !== JSON.stringify(fieldsOf(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [handedBack, setHandedBack] = useState(false);
  const available = typeof window.electronAPI.mutateHumanWork === 'function';
  const mutate = async (mutation: HumanWorkMutation) => {
    setBusy(true); setError('');
    try {
      const result = await window.electronAPI.mutateHumanWork(task.projectId, task.id, mutation);
      if (!result.success || !result.data) throw new Error(result.error ?? t('humanWork.failed'));
      useTaskStore.getState().updateTask(task.id, { metadata: { ...(cached ?? task).metadata, humanWork: result.data } });
    } catch (err) { setError(/No handler registered|mutateHumanWork is not a function/.test(String(err)) ? t('humanWork.restart') : String(err)); } finally { setBusy(false); }
  };
  const handBack = async () => {
    if (!stream) return;
    setBusy(true); setError('');
    try {
      let saved = stream;
      for (const item of overrideActive ? [] : stream.items) {
        const fields = draftFor(item);
        if (!fields.owner.trim() || !fields.response.trim() || !fields.evidence.trim()) throw new Error(t('humanWork.completeFields'));
        if (item.status === 'submitted' && !edited(item)) continue;
        const updated = await window.electronAPI.mutateHumanWork(task.projectId, task.id, { action: 'update', expectedRevision: saved.revision, id: item.id, ...fields, status: 'submitted' });
        if (!updated.success || !updated.data) throw new Error(updated.error ?? t('humanWork.failed'));
        saved = updated.data;
        useTaskStore.getState().updateTask(task.id, { metadata: { ...(cached ?? task).metadata, humanWork: saved } });
      }
      const result = await window.electronAPI.submitReview(task.id, false, undefined, undefined, { humanWorkRevision: saved.revision }, task.projectId);
      if (!result.success) throw new Error(result.error ?? t('humanWork.failed'));
      setHandedBack(true);
    } catch (err) { setError(/No handler registered|mutateHumanWork is not a function/.test(String(err)) ? t('humanWork.restart') : String(err)); } finally { setBusy(false); }
  };
  const overrideAndContinue = async () => {
    setBusy(true); setError('');
    try {
      const updated = await window.electronAPI.mutateHumanWork(task.projectId, task.id, { action: 'override', expectedRevision: stream?.revision ?? 0, approver, reason: overrideReason });
      if (!updated.success || !updated.data) throw new Error(updated.error ?? t('humanWork.failed'));
      useTaskStore.getState().updateTask(task.id, { metadata: { ...(cached ?? task).metadata, humanWork: updated.data } });
      setShowOverride(false);
      const result = await window.electronAPI.submitReview(task.id, false, undefined, undefined, { humanWorkRevision: updated.data.revision }, task.projectId);
      if (!result.success) throw new Error(result.error ?? t('humanWork.failed'));
      setHandedBack(true);
    } catch (err) {
      setError(/No handler registered|Invalid human work action/.test(String(err)) ? t('humanWork.overrideRestart') : String(err));
    } finally { setBusy(false); }
  };
  const remaining = findings.filter((finding) => !stream?.items.some((item) => humanFindingKey(item.finding) === humanFindingKey(finding)));
  const incomplete = stream?.items.filter((item) => { const fields = draftFor(item); return !(fields.owner.trim() && fields.response.trim() && fields.evidence.trim()); }).length ?? 0;
  const ready = overrideActive || !!stream?.items.length && incomplete === 0;
  const needsSubmission = stream?.items.some((item) => item.status !== 'submitted' || edited(item));
  return <section className="mt-4 space-y-3 rounded-lg border border-warning/50 bg-warning/5 p-4" aria-label={t('humanWork.title')}>
    <h3 className="text-sm font-medium">{t('humanWork.title')}</h3><p className="text-xs text-muted-foreground">{t('humanWork.help')}</p>
    {!available && <p role="alert" className="text-sm">{t('humanWork.restart')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {overrideActive && <div role="status" className="space-y-1 rounded border border-primary/50 p-3 text-sm"><p className="font-medium">{t('humanWork.overrideActive', { approver: stream!.approvalOverride!.approver })}</p><p className="whitespace-pre-wrap wrap-anywhere">{stream!.approvalOverride!.reason}</p><p className="text-xs text-muted-foreground">{new Date(stream!.approvalOverride!.at).toLocaleString()} · {t('humanWork.overrideScope')}</p></div>}
    {!showOverride && <Button size="sm" variant="outline" disabled={!available || busy || handedBack} onClick={() => setShowOverride(true)}>{t('humanWork.overrideButton')}</Button>}
    {showOverride && <form className="space-y-3 rounded border border-primary/50 p-3" onSubmit={(event) => { event.preventDefault(); if (approver.trim() && overrideReason.trim()) void overrideAndContinue(); }}>
      <h4 className="text-sm font-medium">{t('humanWork.overrideButton')}</h4><p className="text-xs text-muted-foreground">{t('humanWork.overrideHelp')}</p>
      <label className="block space-y-1 text-xs">{t('humanWork.overrideApprover')}<Input value={approver} maxLength={160} disabled={busy} onChange={(event) => setApprover(event.target.value)} /></label>
      <label className="block space-y-1 text-xs">{t('humanWork.overrideReason')}<textarea rows={3} maxLength={8000} className="block w-full rounded border bg-background p-2 text-sm" disabled={busy} value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} /></label>
      <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={busy || !approver.trim() || !overrideReason.trim()}>{t('humanWork.applyOverride')}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setShowOverride(false)}>{t('humanWork.cancelOverride')}</Button></div>
    </form>}
    {!overrideActive && remaining.map((finding) => <div key={humanFindingKey(finding)} className="space-y-2 rounded border p-3"><p className="text-sm wrap-anywhere">{finding.description}</p><Button size="sm" variant="outline" disabled={!available || busy || handedBack} onClick={() => void mutate({ action: 'create', expectedRevision: stream?.revision ?? 0, finding })}>{t('humanWork.track')}</Button></div>)}
    {stream?.items.map((item) => <HumanAction key={`${item.id}:${item.revision}`} item={item} draft={draftFor(item)} change={(fields) => setDrafts((current) => ({ ...current, [item.id]: { revision: item.revision, fields } }))} disabled={!available || busy || handedBack || overrideActive} save={(fields) => void mutate({ action: 'update', expectedRevision: stream.revision, ...fields })} />)}
    {(!!stream?.items.length || overrideActive) && <><p className="text-xs text-muted-foreground">{t(overrideActive ? 'humanWork.overrideHandoffHelp' : 'humanWork.handoffHelp')}</p>{!overrideActive && incomplete > 0 && <p className="text-xs text-muted-foreground">{t('humanWork.completeFields')}</p>}{!overrideActive && remaining.length > 0 && <p className="text-xs text-muted-foreground">{t('humanWork.trackRemaining', { count: remaining.length })}</p>}<Button size="sm" disabled={!ready || busy || handedBack || !available || (!overrideActive && remaining.length > 0)} onClick={() => void handBack()}>{t(overrideActive ? 'humanWork.continueOverride' : needsSubmission ? 'humanWork.submitAndContinue' : 'humanWork.handBack')}</Button></>}
    {handedBack && <p role="status" className="text-sm">{t('humanWork.handedBack')}</p>}
  </section>;
}
