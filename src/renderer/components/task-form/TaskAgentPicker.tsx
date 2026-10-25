/**
 * TaskAgentPicker - "Model" control of the task dialogs: pin the backend, model and effort a task
 * runs with, or leave it to triage. Claude Code and OMP choices sit side by side, so a task can
 * use a Claude model while the app runs local OMP models (and the other way round).
 *
 * The list of detected OMP models comes from the cached Settings > Agents check; opening the
 * dialog never runs one.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { cn } from '../../lib/utils';
import { readRefreshCache } from '../../lib/refresh-cache';
import { useSettingsStore } from '../../stores/settings-store';
import { CLAUDE_EFFORTS, CLAUDE_MODEL_ALIASES, type ClaudeEffort, type ClaudeModelAlias } from '../../../shared/types/claude-code';
import type { AgentOverride } from '../../../shared/types/task';
import type { OmpDetection } from '../../../shared/types/omp-detection';
import { normalizeAgentOverride, resolveEffectiveAgent } from '../../../shared/utils/agent-override';
import { CLAUDE_TASK_MODEL_LABELS, isModelAlias, pinnedModelLabel, shortOmpModel } from '../../../shared/utils/agent-override-labels';

const OMP_CACHE_KEY = 'omp-detection';
const NO_OMP_MODELS: Partial<Record<ClaudeModelAlias, string>> = {};

const TRIGGER_CLASS =
  'inline-flex h-8 max-w-[16rem] items-center gap-1.5 rounded-md px-2 text-sm text-foreground transition-colors hover:bg-nav-hover focus-visible:outline-none focus-visible:shadow-(--shadow-focus) disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-nav-hover';
const ITEM_CLASS = 'cursor-pointer rounded-lg px-3 py-2 text-sm focus:bg-nav-hover data-[highlighted]:bg-nav-hover';

interface TaskAgentPickerProps {
  value: AgentOverride | undefined;
  onChange: (value: AgentOverride | undefined) => void;
  disabled?: boolean;
  /** Model only, no effort control and no hint (per task in the breakdown review) */
  compact?: boolean;
  idPrefix?: string;
}

export function TaskAgentPicker({ value, onChange, disabled = false, compact = false, idPrefix = '' }: TaskAgentPickerProps) {
  const { t } = useTranslation(['tasks', 'settings']);
  // Stable references only (a fresh object from a selector loops forever under Zustand 5)
  const agentBackend = useSettingsStore((state) => state.settings.agentBackend);
  const appBackend = agentBackend?.kind ?? 'claude';
  const ompModels = agentBackend?.omp?.models ?? NO_OMP_MODELS;
  const detected = useMemo(() => readRefreshCache<OmpDetection>(OMP_CACHE_KEY)?.models ?? [], []);

  const effective = resolveEffectiveAgent(value, appBackend);
  // "Other ... model" chosen but nothing typed yet
  const [customOpen, setCustomOpen] = useState<'claude' | 'omp' | null>(null);

  const model = value?.model;
  const knownForClaude = isModelAlias(model);
  const knownForOmp = isModelAlias(model) || detected.some((m) => m.selector === model);
  const isCustom = !!model && !(value?.backend === 'omp' ? knownForOmp : knownForClaude);
  const customBackend = customOpen ?? (isCustom ? effective.backend : null);

  const set = (patch: AgentOverride) => onChange(normalizeAgentOverride({ effort: value?.effort, ...patch }));
  const ompTierLabel = (alias: ClaudeModelAlias) => {
    const mapped = ompModels[alias]?.trim();
    return mapped ? shortOmpModel(mapped) : t('settings:agentBackend.ompDefaultRole');
  };

  const triggerLabel = pinnedModelLabel(value, appBackend, agentBackend?.omp?.models) ?? t('tasks:agentPicker.auto');
  const check = (selected: boolean) =>
    selected ? <Check className="ml-3 h-4 w-4 shrink-0 text-(--menu-check)" strokeWidth={2} /> : <span className="ml-3 w-4 shrink-0" />;
  const isSelected = (backend: 'claude' | 'omp', m: string) => !customBackend && value?.backend === backend && value.model === m;

  const hint = !compact && value?.model
    ? effective.backend === 'claude' && appBackend === 'omp'
      ? t('tasks:agentPicker.usesClaudeAccount')
      : effective.backend === 'omp' && appBackend === 'claude'
        ? t('tasks:agentPicker.usesOmp')
        : undefined
    : undefined;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              id={`${idPrefix ? `${idPrefix}-` : ''}task-model`}
              className={TRIGGER_CLASS}
              disabled={disabled}
              title={t('tasks:agentPicker.title')}
              aria-label={t('tasks:agentPicker.title')}
            >
              <span className="truncate">{triggerLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="max-h-96 w-72 overflow-y-auto rounded-xl p-1.5">
            <DropdownMenuItem
              className={cn(ITEM_CLASS, 'flex items-center')}
              onSelect={() => { setCustomOpen(null); onChange(normalizeAgentOverride({ effort: value?.effort })); }}
            >
              <span className="min-w-0 flex-1 truncate">{t('tasks:agentPicker.auto')}</span>
              {check(!value?.model && !customBackend)}
            </DropdownMenuItem>

            <DropdownMenuSeparator className="mx-2 my-1.5" />
            <DropdownMenuLabel className="px-3 py-1 text-xs text-muted-foreground">{t('tasks:agentPicker.claudeGroup')}</DropdownMenuLabel>
            {CLAUDE_MODEL_ALIASES.map((alias) => (
              <DropdownMenuItem
                key={`claude-${alias}`}
                className={cn(ITEM_CLASS, 'flex items-center')}
                onSelect={() => { setCustomOpen(null); set({ backend: 'claude', model: alias }); }}
              >
                <span className="min-w-0 flex-1 truncate">{CLAUDE_TASK_MODEL_LABELS[alias]}</span>
                {check(isSelected('claude', alias))}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              className={cn(ITEM_CLASS, 'flex items-center')}
              onSelect={() => { setCustomOpen('claude'); set({ backend: 'claude', model: isCustom && effective.backend === 'claude' ? model : undefined }); }}
            >
              <span className="min-w-0 flex-1 truncate">{t('tasks:agentPicker.otherClaude')}</span>
              {check(customBackend === 'claude')}
            </DropdownMenuItem>

            <DropdownMenuSeparator className="mx-2 my-1.5" />
            <DropdownMenuLabel className="px-3 py-1 text-xs text-muted-foreground">{t('tasks:agentPicker.ompGroup')}</DropdownMenuLabel>
            {CLAUDE_MODEL_ALIASES.map((alias) => (
              <DropdownMenuItem
                key={`omp-${alias}`}
                className={cn(ITEM_CLASS, 'flex items-center')}
                onSelect={() => { setCustomOpen(null); set({ backend: 'omp', model: alias }); }}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{ompTierLabel(alias)}</div>
                  <div className="text-[0.8125rem] text-muted-foreground">{t(`settings:agentBackend.tiers.${alias}`)}</div>
                </div>
                {check(isSelected('omp', alias))}
              </DropdownMenuItem>
            ))}
            {detected.length > 0 && (
              <>
                <DropdownMenuLabel className="px-3 pb-1 pt-2 text-xs text-muted-foreground">{t('tasks:agentPicker.detected')}</DropdownMenuLabel>
                {detected.map((m) => (
                  <DropdownMenuItem
                    key={m.selector}
                    className={cn(ITEM_CLASS, 'flex items-center')}
                    onSelect={() => { setCustomOpen(null); set({ backend: 'omp', model: m.selector }); }}
                  >
                    <span className="min-w-0 flex-1 truncate" title={m.selector}>{m.selector}</span>
                    {check(isSelected('omp', m.selector))}
                  </DropdownMenuItem>
                ))}
              </>
            )}
            <DropdownMenuItem
              className={cn(ITEM_CLASS, 'flex items-center')}
              onSelect={() => { setCustomOpen('omp'); set({ backend: 'omp', model: isCustom && effective.backend === 'omp' ? model : undefined }); }}
            >
              <span className="min-w-0 flex-1 truncate">{t('tasks:agentPicker.otherOmp')}</span>
              {check(customBackend === 'omp')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {!compact && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                id={`${idPrefix ? `${idPrefix}-` : ''}task-effort`}
                className={TRIGGER_CLASS}
                disabled={disabled}
                title={t('tasks:agentPicker.effort')}
                aria-label={t('tasks:agentPicker.effort')}
              >
                <span className="shrink-0 text-muted-foreground">{t('tasks:agentPicker.effort')}</span>
                <span className="truncate">
                  {value?.effort ? t(`tasks:agentPicker.effortLevel.${value.effort}`) : t('tasks:agentPicker.effortAuto')}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="w-48 rounded-xl p-1.5">
              <DropdownMenuItem
                className={cn(ITEM_CLASS, 'flex items-center')}
                onSelect={() => onChange(normalizeAgentOverride({ ...value, effort: undefined }))}
              >
                <span className="min-w-0 flex-1">{t('tasks:agentPicker.effortAuto')}</span>
                {check(!value?.effort)}
              </DropdownMenuItem>
              {CLAUDE_EFFORTS.map((effort: ClaudeEffort) => (
                <DropdownMenuItem
                  key={effort}
                  className={cn(ITEM_CLASS, 'flex items-center')}
                  onSelect={() => onChange(normalizeAgentOverride({ ...value, effort }))}
                >
                  <span className="min-w-0 flex-1">{t(`tasks:agentPicker.effortLevel.${effort}`)}</span>
                  {check(value?.effort === effort)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {customBackend && (
        <input
          type="text"
          value={isCustom || customOpen ? model ?? '' : ''}
          disabled={disabled}
          onChange={(e) => { setCustomOpen(customBackend); set({ backend: customBackend, model: e.target.value }); }}
          placeholder={customBackend === 'omp' ? t('tasks:agentPicker.ompIdPlaceholder') : t('tasks:agentPicker.claudeIdPlaceholder')}
          aria-label={t('tasks:agentPicker.customLabel')}
          spellCheck={false}
          className="field-border h-8 w-64 rounded-lg border border-border bg-transparent px-2 font-mono text-sm text-foreground focus:outline-none"
        />
      )}
      {hint && <p className="text-xs text-(--nav-label-color)">{hint}</p>}
    </div>
  );
}
