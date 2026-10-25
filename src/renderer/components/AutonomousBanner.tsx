import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitMerge, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import type { AutonomousStatus } from '../../shared/types/autonomous';

interface AutonomousBannerProps {
  projectId: string;
  /** Changes whenever the board's tasks change, so the count is read again (a string, so it is stable) */
  tasksSignature: string;
}

/**
 * Board header line for an integration branch: "workbench/auto is N tasks ahead of main" with a
 * "Merge into main" action. Read when the board opens and when automatic merges happen, never
 * polled. Hidden while autonomous mode is off or merges go straight into the base branch.
 */
export function AutonomousBanner({ projectId, tasksSignature }: AutonomousBannerProps) {
  const { t } = useTranslation('tasks');
  const [status, setStatus] = useState<AutonomousStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);

  const load = useCallback(async () => {
    const result = await window.electronAPI.getAutonomousStatus(projectId);
    if (result.success) setStatus(result.data ?? null);
  }, [projectId]);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
    return window.electronAPI.onAutonomousChanged((changed) => {
      if (changed === projectId) void loadRef.current();
    });
  }, [projectId]);
  // A task moving to Done or a new auto-merge changes the count
  useEffect(() => {
    void loadRef.current();
  }, [tasksSignature]);

  if (!status || !status.enabled || status.target !== 'integration') return null;

  const mergeIntoBase = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.mergeIntegrationIntoBase(projectId);
      if (!result.success) {
        setMessage({ text: t('autonomous.banner.failed', { error: result.error ?? '' }), isError: true });
      } else if (result.data?.pushError) {
        setMessage({ text: t('autonomous.banner.pushFailed', { error: result.data.pushError }), isError: true });
      } else {
        setMessage({ text: t('autonomous.banner.merged', { base: status.baseBranch }), isError: false });
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-6 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-(--nav-label-color)">
      <GitMerge className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 wrap-anywhere">
        {status.ahead > 0
          ? t('autonomous.banner.ahead', { count: status.ahead, branch: status.branch, base: status.baseBranch })
          : t('autonomous.banner.upToDate', { branch: status.branch, base: status.baseBranch })}
      </span>
      {status.ahead > 0 && (
        <Button size="sm" variant="ghost" className="h-7" onClick={() => void mergeIntoBase()} disabled={busy}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {busy ? t('autonomous.banner.merging') : t('autonomous.banner.mergeInto', { base: status.baseBranch })}
        </Button>
      )}
      {message && (
        <span role={message.isError ? 'alert' : 'status'} className={message.isError ? 'text-xs text-destructive wrap-anywhere' : 'text-xs'}>
          {message.text}
        </span>
      )}
    </div>
  );
}
