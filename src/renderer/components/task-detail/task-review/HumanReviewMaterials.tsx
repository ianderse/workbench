import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '../../../../shared/types';
import type { HumanReviewArtifact, HumanReviewPacket } from '../../../../shared/types/human-work';
import { Button } from '../../ui/button';

const packets = new Map<string, HumanReviewPacket>();

export function HumanReviewMaterials({ task }: { task: Task }) {
  const { t } = useTranslation('tasks');
  const key = `${task.projectId}:${task.specId}:${task.claudeRun?.phases?.at(-1)?.endedAt ?? ''}`;
  const [packet, setPacket] = useState(() => packets.get(key));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const available = typeof window.electronAPI.getHumanReviewPacket === 'function';
  const load = async (live = () => true) => {
    setBusy(true); setError('');
    try {
      const result = await window.electronAPI.getHumanReviewPacket(task.projectId, task.id);
      if (!result.success || !result.data) throw new Error(result.error ?? t('humanWork.materialsFailed'));
      if (live()) { packets.set(key, result.data); setPacket(result.data); }
    } catch (err) { if (live()) setError(/No handler registered/.test(String(err)) ? t('humanWork.materialsRestart') : String(err)); }
    finally { if (live()) setBusy(false); }
  };
  useEffect(() => {
    let live = true;
    setPacket(packets.get(key));
    if (available && !packets.has(key)) void load(() => live);
    return () => { live = false; };
  }, [key, available]);
  const open = async (reference: string, action: 'open' | 'reveal') => {
    setBusy(true); setError('');
    try {
      if (!packet) return;
      const result = await window.electronAPI.openHumanReviewArtifact(task.projectId, task.id, reference, action, packet.root);
      if (!result.success) throw new Error(result.error ?? t('humanWork.materialsFailed'));
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const featured = packet ? [...new Set([
    ...(['report', 'protocol', 'gallery'] as const).map(kind => packet.artifacts.find(artifact => artifact.kind === kind && artifact.available && (kind !== 'gallery' || artifact.directory))
      ?? packet.artifacts.find(artifact => artifact.kind === kind && artifact.available)
      ?? packet.artifacts.find(artifact => artifact.kind === kind)),
    packet.artifacts.find(artifact => /(?:^|[\\/])generated$/.test(artifact.path)),
  ].filter((artifact): artifact is HumanReviewArtifact => !!artifact))] : [];
  const additional = packet?.artifacts.filter(artifact => !featured.includes(artifact)) ?? [];
  const row = (artifact: HumanReviewArtifact) => <li key={artifact.path} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded border p-2 text-xs">
    <div className="min-w-0 space-y-1">
      <p className="font-medium">{t(`humanWork.materialKinds.${artifact.kind}`)}: {artifact.label}</p>
      <p className="break-all font-mono text-muted-foreground">{artifact.path}</p>
      {!artifact.available ? <p className="text-warning">{t('humanWork.materialMissing')}</p>
        : artifact.imageCount !== undefined && <p>{t('humanWork.imageCount', { count: artifact.imageCount })}</p>}
      {/(?:^|[\\/])generated$/.test(artifact.path) && (!artifact.available || artifact.imageCount === 0) && <p className="text-warning">{t('humanWork.noGeneratedImages')}</p>}
    </div>
    {artifact.available && <div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" disabled={busy} onClick={() => void open(artifact.path, 'open')}>{t('humanWork.openMaterial')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void open(artifact.path, 'reveal')}>{t('humanWork.revealMaterial')}</Button></div>}
  </li>;
  return <div className="space-y-2 rounded border p-3">
    <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-medium">{t('humanWork.materialsTitle')}</h4>{available && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>{t('humanWork.refreshMaterials')}</Button>}</div>
    {!available && <p className="text-xs text-muted-foreground">{t('humanWork.materialsRestart')}</p>}
    {error && <p className="text-xs text-destructive">{error}</p>}
    {packet && <>
      <p className="text-xs text-muted-foreground">{t(`humanWork.materialsLocation.${packet.location}`)}</p>
      <details className="text-xs"><summary>{t('humanWork.exactLocation')}</summary><p className="mt-1 break-all font-mono">{packet.root}</p></details>
      {!packet.artifacts.length && <p className="text-xs text-muted-foreground">{t('humanWork.noMaterials')}</p>}
      <ul className="space-y-2">{featured.map(row)}</ul>
      {!!additional.length && <details className="text-xs"><summary>{t('humanWork.otherMaterials', { count: additional.length })}</summary><ul className="mt-2 space-y-2">{additional.map(row)}</ul></details>}
      {packet.limitations && <details className="rounded border border-warning/40 p-2 text-xs"><summary>{t('humanWork.reportedLimitations')}</summary><p className="mt-2 whitespace-pre-wrap wrap-anywhere">{packet.limitations}</p></details>}
    </>}
  </div>;
}
