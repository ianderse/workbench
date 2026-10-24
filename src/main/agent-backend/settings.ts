import {
  AGENT_BACKEND_KINDS,
  DEFAULT_AGENT_BACKEND_SETTINGS,
  DEFAULT_OMP_BACKEND_SETTINGS,
  type AgentBackendKind,
  type AgentBackendSettings,
} from '../../shared/types/agent-backend';
import { readSettingsFile } from '../settings-utils';

/** Complete backend settings from the stored (partial) `AppSettings.agentBackend` */
export function resolveAgentBackendSettings(stored: Partial<AgentBackendSettings> | undefined): AgentBackendSettings {
  const kind: AgentBackendKind = stored?.kind && AGENT_BACKEND_KINDS.includes(stored.kind) ? stored.kind : DEFAULT_AGENT_BACKEND_SETTINGS.kind;
  const omp = stored?.omp ?? DEFAULT_OMP_BACKEND_SETTINGS;
  return {
    kind,
    omp: {
      ...DEFAULT_OMP_BACKEND_SETTINGS,
      ...omp,
      command: omp.command?.trim() || DEFAULT_OMP_BACKEND_SETTINGS.command,
      models: { ...(omp.models ?? {}) },
      thinking: { ...DEFAULT_OMP_BACKEND_SETTINGS.thinking, ...(omp.thinking ?? {}) },
    },
  };
}

/** Backend settings as currently saved */
export function getAgentBackendSettings(): AgentBackendSettings {
  const settings = readSettingsFile() as { agentBackend?: Partial<AgentBackendSettings> } | undefined;
  return resolveAgentBackendSettings(settings?.agentBackend);
}

/** True when AI work runs through OMP instead of Claude Code */
export function isOmpBackend(): boolean {
  return getAgentBackendSettings().kind === 'omp';
}

/** Name of the agent backend in use, for text the user sees ("Claude Code" or "OMP") */
export function agentDisplayName(): string {
  return isOmpBackend() ? 'OMP' : 'Claude Code';
}
