import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Copy } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { cn } from '../../lib/utils';
import { buildResumeCommand, formatCostUsd, formatDurationMs } from '../../../shared/utils/claude-run';
import type { ClaudeRunInfo, ClaudeRunPhase } from '../../../shared/types';

/** Same Markdown look as the task description */
const MARKDOWN_CLASS =
  'prose prose-sm dark:prose-invert max-w-none overflow-hidden prose-p:text-foreground/90 prose-p:leading-relaxed prose-headings:text-foreground prose-strong:text-foreground prose-li:text-foreground/90 prose-ul:my-2 prose-li:my-0.5 prose-a:break-all prose-pre:overflow-x-auto [&_code]:break-all [&_code]:whitespace-pre-wrap [&_*]:max-w-full';

interface TaskClaudeRunProps {
  run: ClaudeRunInfo;
}

function phaseDurationMs(phase: ClaudeRunPhase): number | undefined {
  if (phase.durationMs !== undefined) return phase.durationMs;
  if (!phase.endedAt) return undefined;
  const ms = new Date(phase.endedAt).getTime() - new Date(phase.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** A collapsed-by-default block with the same trigger look as the log sections */
function CollapsibleBlock({ label, meta, children }: { label: string; meta?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-xl border border-border p-3 text-left transition-colors hover:bg-nav-hover"
        >
          <span className="text-sm text-foreground">{label}</span>
          {meta && <span className="text-xs text-(--nav-label-color)">{meta}</span>}
          <ChevronRight
            className={cn(
              'ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
              open && 'rotate-90'
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Comma-separated names, or "None" */
function NameList({ names }: { names: string[] }) {
  const { t } = useTranslation(['tasks']);
  if (names.length === 0) return <>{t('tasks:claudeRun.none')}</>;
  return <span className="break-words">{names.join(', ')}</span>;
}

/**
 * The task's Claude Code run: triage decision, plan, validation report, summary, steps with
 * cost, subagents, what the session loaded, and the session id with a resume command.
 */
export function TaskClaudeRun({ run }: TaskClaudeRunProps) {
  const { t } = useTranslation(['tasks']);
  const [copied, setCopied] = useState(false);
  const { triage, validation, init } = run;

  const modelLabel = (model: string) => t(`tasks:claudeRun.models.${model}`, { defaultValue: model });
  const effortLabel = (effort: string) => t(`tasks:claudeRun.efforts.${effort}`, { defaultValue: effort });

  const handleCopyResume = async () => {
    if (!run.sessionId) return;
    try {
      await navigator.clipboard.writeText(buildResumeCommand(run.sessionId, run.worktreePath));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy resume command:', err);
    }
  };

  return (
    <section className="space-y-3" aria-label={t('tasks:claudeRun.title')}>
      <h3 className="text-[0.9375rem] font-semibold leading-5 text-foreground">{t('tasks:claudeRun.title')}</h3>

      <SettingsRows>
        {/* Triage decision */}
        {triage && (
          <SettingsRow
            label={t('tasks:claudeRun.triage.label')}
            description={
              <div className="space-y-1">
                <div className="text-foreground/90">
                  {[
                    t('tasks:claudeRun.modelEffort', { model: modelLabel(triage.model), effort: effortLabel(triage.effort) }),
                    triage.needsPlan ? t('tasks:claudeRun.triage.planFirst') : t('tasks:claudeRun.triage.noPlan'),
                    t('tasks:claudeRun.triage.scope', { scope: t(`tasks:claudeRun.scopes.${triage.scope}`, { defaultValue: triage.scope }) })
                  ].join(' · ')}
                </div>
                {triage.reasoning && <p>{triage.reasoning}</p>}
                {triage.verification.length > 0 && (
                  <p>
                    {t('tasks:claudeRun.triage.verification')}{' '}
                    <span className="font-mono text-xs">{triage.verification.join(', ')}</span>
                  </p>
                )}
                <p>{t(`tasks:claudeRun.triage.source.${triage.source}`)}</p>
              </div>
            }
          />
        )}

        {/* Validation report */}
        {validation && (
          <SettingsRow
            label={t('tasks:claudeRun.validation.label')}
            description={
              <div className="space-y-2">
                <div className="text-foreground/90">
                  {t(`tasks:claudeRun.validation.status.${validation.status}`)}
                  {validation.summary && <span className="text-(--nav-label-color)">{` · ${validation.summary}`}</span>}
                </div>
                {validation.checks.length > 0 && (
                  <ul className="space-y-1">
                    {validation.checks.map((check, idx) => (
                      <li key={`${check.name}-${idx}`}>
                        <span className="text-foreground/90">{check.name}</span>
                        {' · '}
                        {check.passed ? t('tasks:claudeRun.validation.checkPassed') : t('tasks:claudeRun.validation.checkFailed')}
                        {check.command && <div className="font-mono text-xs break-all">{check.command}</div>}
                        {check.details && <div className="text-xs break-words">{check.details}</div>}
                      </li>
                    ))}
                  </ul>
                )}
                {validation.findings.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-foreground/90">{t('tasks:claudeRun.validation.findings')}</div>
                    <ul className="space-y-1">
                      {validation.findings.map((finding, idx) => (
                        <li key={idx} className="break-words">
                          {t(`tasks:claudeRun.validation.severity.${finding.severity}`)}
                          {' · '}
                          {finding.fixed ? t('tasks:claudeRun.validation.fixed') : t('tasks:claudeRun.validation.notFixed')}
                          {': '}
                          {finding.description}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            }
          />
        )}

        {/* Final summary */}
        {run.summary && (
          <SettingsRow
            label={t('tasks:claudeRun.summary')}
            description={
              <div className={MARKDOWN_CLASS} style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{run.summary}</ReactMarkdown>
              </div>
            }
          />
        )}

        {/* Run steps */}
        {run.phases.length > 0 && (
          <SettingsRow
            label={t('tasks:claudeRun.steps.label')}
            description={
              <ul className="space-y-1">
                {run.phases.map((phase, idx) => {
                  const duration = phaseDurationMs(phase);
                  const parts = [
                    phase.model ? modelLabel(phase.model) : null,
                    phase.effort ? effortLabel(phase.effort) : null,
                    duration !== undefined ? formatDurationMs(duration) : !phase.endedAt ? t('tasks:claudeRun.steps.running') : null,
                    phase.costUsd !== undefined ? formatCostUsd(phase.costUsd) : null
                  ].filter(Boolean);
                  return (
                    <li key={`${phase.name}-${phase.startedAt}-${idx}`}>
                      <span className="text-foreground/90">
                        {t(`tasks:claudeRun.steps.names.${phase.name}`, { defaultValue: phase.name })}
                      </span>
                      {parts.length > 0 && ` · ${parts.join(' · ')}`}
                      {(phase.isError || phase.error) && (
                        <div className="text-xs text-destructive break-words">
                          {phase.error || t('tasks:claudeRun.steps.failed')}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            }
          />
        )}

        {/* Total cost */}
        <SettingsRow label={t('tasks:claudeRun.totalCost')}>
          <span className="text-sm text-foreground tabular-nums">{formatCostUsd(run.totalCostUsd ?? 0)}</span>
        </SettingsRow>

        {/* Subagents Claude Code started */}
        {run.subagents.length > 0 && (
          <SettingsRow
            label={t('tasks:claudeRun.subagents.label')}
            description={
              <ul className="space-y-1">
                {run.subagents.map((sub) => (
                  <li key={sub.id} className="break-words">
                    <span className="text-foreground/90">{sub.description}</span>
                    {sub.type && ` · ${sub.type}`}
                    {` · ${t(`tasks:claudeRun.subagents.status.${sub.status}`)}`}
                  </li>
                ))}
              </ul>
            }
          />
        )}

        {/* Session id + resume command */}
        {run.sessionId && (
          <SettingsRow
            label={t('tasks:claudeRun.session.label')}
            description={<span className="font-mono text-xs break-all">{run.sessionId}</span>}
          >
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={handleCopyResume}>
              <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
              {copied ? t('tasks:claudeRun.session.copied') : t('tasks:claudeRun.session.copyResume')}
            </Button>
          </SettingsRow>
        )}
      </SettingsRows>

      {/* The plan Claude Code wrote before implementing */}
      {run.plan && (
        <CollapsibleBlock label={t('tasks:claudeRun.plan')}>
          <div className="max-w-full overflow-hidden rounded-xl bg-segment-track px-4 py-3">
            <div className={MARKDOWN_CLASS} style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{run.plan}</ReactMarkdown>
            </div>
          </div>
        </CollapsibleBlock>
      )}

      {/* What the session loaded (from Claude Code's init event) */}
      {init && (
        <CollapsibleBlock
          label={t('tasks:claudeRun.loaded.label')}
          meta={init.claudeCodeVersion ? t('tasks:claudeRun.loaded.version', { version: init.claudeCodeVersion }) : undefined}
        >
          <SettingsRows className="px-1">
            <SettingsRow
              label={t('tasks:claudeRun.loaded.mcpServers')}
              description={
                init.mcpServers.length === 0 ? (
                  t('tasks:claudeRun.none')
                ) : (
                  <ul className="space-y-0.5">
                    {init.mcpServers.map((server) => (
                      <li key={server.name} className="break-words">
                        <span className="text-foreground/90">{server.name}</span>
                        {` · ${t(`tasks:claudeRun.loaded.mcpStatus.${server.status}`, { defaultValue: server.status })}`}
                      </li>
                    ))}
                  </ul>
                )
              }
            />
            <SettingsRow label={t('tasks:claudeRun.loaded.skills')} description={<NameList names={init.skills} />} />
            <SettingsRow label={t('tasks:claudeRun.loaded.agents')} description={<NameList names={init.agents} />} />
            <SettingsRow label={t('tasks:claudeRun.loaded.plugins')} description={<NameList names={init.plugins} />} />
          </SettingsRows>
        </CollapsibleBlock>
      )}
    </section>
  );
}
