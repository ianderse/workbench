import { useSettingsStore } from '../stores/settings-store';

/** True while AI work runs through OMP instead of Claude Code (a boolean, so the selector is stable) */
export function useIsOmpBackend(): boolean {
  return useSettingsStore((state) => state.settings.agentBackend?.kind === 'omp');
}
