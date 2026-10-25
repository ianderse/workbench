/**
 * Agent backend section of the Agents page: Claude Code (default) or OMP (local models).
 * OMP's model endpoints live in ~/.omp/agent/models.yml; this maps Workbench's model sizes to them.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { SettingsSection } from './SettingsSection';
import { SegmentedControl, SettingsRow, SettingsRows } from './SettingsRow';
import { readRefreshCache, writeRefreshCache } from '../../lib/refresh-cache';
import { CLAUDE_EFFORTS, CLAUDE_MODEL_ALIASES, type ClaudeEffort, type ClaudeModelAlias } from '../../../shared/types/claude-code';
import {
  DEFAULT_OMP_BACKEND_SETTINGS,
  type AgentBackendKind,
  type AgentBackendSettings,
  type OmpAdvisorMode,
  type OmpThinkingLevel
} from '../../../shared/types/agent-backend';
import type { OmpDetection } from '../../../shared/types/omp-detection';
import type { AppSettings } from '../../../shared/types';

const OMP_CACHE_KEY = 'omp-detection';
const DEFAULT_VALUE = '__omp-default__';
const THINKING_LEVELS: OmpThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'];

interface AgentBackendSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

export function AgentBackendSettings({ settings, onSettingsChange }: AgentBackendSettingsProps) {
  const { t } = useTranslation('settings');
  const stored = settings.agentBackend;
  const kind: AgentBackendKind = stored?.kind ?? 'claude';
  const omp = { ...DEFAULT_OMP_BACKEND_SETTINGS, ...(stored?.omp ?? {}) };

  const [detection, setDetection] = useState<OmpDetection | undefined>(() => readRefreshCache<OmpDetection>(OMP_CACHE_KEY));
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | undefined>();

  const update = (patch: Partial<AgentBackendSettings>) => {
    onSettingsChange({ ...settings, agentBackend: { ...stored, ...patch } });
  };
  const updateOmp = (patch: Partial<typeof omp>) => update({ omp: { ...omp, ...patch } });

  const detect = useCallback(async () => {
    setChecking(true);
    setCheckError(undefined);
    try {
      const result = await window.electronAPI.detectOmp();
      if (result.success && result.data) {
        setDetection(result.data);
        writeRefreshCache(OMP_CACHE_KEY, result.data);
      } else {
        setCheckError(result.error ?? '');
      }
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }, []);

  // Show the last check; check once when OMP is chosen and nothing was checked before
  useEffect(() => {
    if (kind === 'omp' && !detection) void detect();
  }, [kind, detection, detect]);

  const models = detection?.models ?? [];

  let status: string;
  if (checking) status = t('agentBackend.statusChecking');
  else if (checkError !== undefined) status = t('agentBackend.statusFailed', { error: checkError });
  else if (detection?.installed)
    status = detection.version ? t('agentBackend.statusFound', { version: detection.version }) : t('agentBackend.statusFoundNoVersion');
  else if (detection?.error) status = t('agentBackend.statusFailed', { error: detection.error });
  else status = t('agentBackend.statusNotFound');

  /** Model picker: the detected OMP models with an "OMP default" entry, or free text when none were found */
  const modelPicker = (id: string, value: string, save: (v: string) => void, defaultLabel = t('agentBackend.ompDefault')) => {
    if (models.length === 0) {
      return (
        <Input
          id={id}
          className="w-64"
          value={value}
          placeholder={t('agentBackend.modelPlaceholder')}
          onChange={(e) => save(e.target.value.trim())}
        />
      );
    }
    return (
      <Select value={value || DEFAULT_VALUE} onValueChange={(v) => save(v === DEFAULT_VALUE ? '' : v)}>
        <SelectTrigger id={id} className="h-8 w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_VALUE}>{defaultLabel}</SelectItem>
          {value && !models.some((m) => m.selector === value) && <SelectItem value={value}>{value}</SelectItem>}
          {models.map((m) => (
            <SelectItem key={m.selector} value={m.selector}>
              {m.selector}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };

  const modelControl = (tier: ClaudeModelAlias) =>
    modelPicker(`omp-model-${tier}`, omp.models[tier] ?? '', (v) => {
      const next = { ...omp.models };
      if (v) next[tier] = v;
      else delete next[tier];
      updateOmp({ models: next });
    }, t('agentBackend.useOmpRoles'));

  return (
    <>
      <SettingsSection title={t('agentBackend.title')}>
        <SettingsRows>
          <SettingsRow label={t('agentBackend.backend')} description={t('agentBackend.backendDescription')}>
            <SegmentedControl<AgentBackendKind>
              value={kind}
              onValueChange={(next) => update({ kind: next })}
              ariaLabel={t('agentBackend.backend')}
              options={[
                { value: 'claude', label: t('agentBackend.kinds.claude') },
                { value: 'omp', label: t('agentBackend.kinds.omp') }
              ]}
            />
          </SettingsRow>

          {kind === 'omp' && (
            <>
              <SettingsRow
                label={t('agentBackend.command')}
                description={t('agentBackend.commandDescription')}
                htmlFor="omp-command"
              >
                <Input
                  id="omp-command"
                  className="w-64"
                  value={stored?.omp?.command ?? ''}
                  placeholder={t('agentBackend.commandPlaceholder')}
                  onChange={(e) => updateOmp({ command: e.target.value.trim() })}
                />
              </SettingsRow>
              <SettingsRow
                label={t('agentBackend.status')}
                description={
                  <>
                    {status}
                    {detection?.installed && models.length > 0 && (
                      <span className="block">{t('agentBackend.modelsCount', { count: models.length })}</span>
                    )}
                    {detection?.installed && models.length === 0 && !checking && (
                      <span className="block">{t('agentBackend.noModels')}</span>
                    )}
                  </>
                }
              >
                <Button variant="outline" size="sm" disabled={checking} onClick={() => void detect()}>
                  <RefreshCw className={checking ? 'mr-2 h-3.5 w-3.5 animate-spin' : 'mr-2 h-3.5 w-3.5'} />
                  {t('agentBackend.refresh')}
                </Button>
              </SettingsRow>
            </>
          )}
        </SettingsRows>
      </SettingsSection>

      {kind === 'omp' && (
        <>
          <SettingsSection title={t('agentBackend.modelsTitle')} description={t('agentBackend.modelsDescription')}>
            <p className="mb-3 text-[0.8125rem] text-muted-foreground">{t('agentBackend.modelsDescription')}</p>
            <SettingsRows>
              {CLAUDE_MODEL_ALIASES.map((tier) => (
                <SettingsRow key={tier} label={t(`agentBackend.tiers.${tier}`)} htmlFor={`omp-model-${tier}`}>
                  {modelControl(tier)}
                </SettingsRow>
              ))}
            </SettingsRows>
          </SettingsSection>

          <SettingsSection title={t('agentBackend.advisorTitle')} description={t('agentBackend.advisorDescription')}>
            <SettingsRows>
              <SettingsRow label={t('agentBackend.advisor')} description={t('agentBackend.advisorModeDescription')}>
                <SegmentedControl<OmpAdvisorMode>
                  value={omp.advisor ?? 'inherit'}
                  onValueChange={(next) => updateOmp({ advisor: next })}
                  ariaLabel={t('agentBackend.advisor')}
                  options={[
                    { value: 'inherit', label: t('agentBackend.advisorModes.inherit') },
                    { value: 'on', label: t('agentBackend.advisorModes.on') },
                    { value: 'off', label: t('agentBackend.advisorModes.off') }
                  ]}
                />
              </SettingsRow>
              <SettingsRow
                label={t('agentBackend.advisorModel')}
                description={t('agentBackend.advisorModelDescription')}
                htmlFor="omp-advisor-model"
              >
                {modelPicker('omp-advisor-model', omp.advisorModel ?? '', (v) => updateOmp({ advisorModel: v }))}
              </SettingsRow>
            </SettingsRows>
          </SettingsSection>

          <SettingsSection title={t('agentBackend.fallbackTitle')}>
            <SettingsRows>
              <SettingsRow
                label={t('agentBackend.allowFallbackModels')}
                description={t('agentBackend.allowFallbackModelsDescription')}
                htmlFor="omp-allow-fallback"
              >
                <Switch
                  id="omp-allow-fallback"
                  checked={omp.allowFallbackModels === true}
                  onCheckedChange={(checked) => updateOmp({ allowFallbackModels: checked })}
                />
              </SettingsRow>
              <SettingsRow
                label={t('agentBackend.retries')}
                description={t('agentBackend.retriesDescription')}
                htmlFor="omp-retries"
              >
                <Input
                  id="omp-retries"
                  type="number"
                  min={0}
                  max={10}
                  className="w-20"
                  value={omp.retries ?? 5}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (e.target.value === '' || !Number.isFinite(value)) return;
                    updateOmp({ retries: Math.min(10, Math.max(0, Math.round(value))) });
                  }}
                />
              </SettingsRow>
            </SettingsRows>
          </SettingsSection>

          <SettingsSection title={t('agentBackend.thinkingTitle')} description={t('agentBackend.thinkingDescription')}>
            <SettingsRows>
              {CLAUDE_EFFORTS.map((effort: ClaudeEffort) => (
                <SettingsRow key={effort} label={t(`claudeCode.efforts.${effort}`)} htmlFor={`omp-thinking-${effort}`}>
                  <Select
                    value={omp.thinking[effort]}
                    onValueChange={(v) => updateOmp({ thinking: { ...omp.thinking, [effort]: v as OmpThinkingLevel } })}
                  >
                    <SelectTrigger id={`omp-thinking-${effort}`} className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {THINKING_LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {t(`agentBackend.thinkingLevels.${level}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsRow>
              ))}
              <SettingsRow
                label={t('agentBackend.maxMinutes')}
                description={t('agentBackend.maxMinutesDescription')}
                htmlFor="omp-max-minutes"
              >
                <Input
                  id="omp-max-minutes"
                  type="number"
                  min={0}
                  className="w-20"
                  value={omp.maxPhaseMinutes ?? 0}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (e.target.value === '' || !Number.isFinite(value)) return;
                    updateOmp({ maxPhaseMinutes: Math.max(0, Math.round(value)) });
                  }}
                />
              </SettingsRow>
            </SettingsRows>
          </SettingsSection>
        </>
      )}
    </>
  );
}
