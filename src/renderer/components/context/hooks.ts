import { refreshProjectIndex } from '../../stores/context-store';

export function useRefreshIndex(projectId: string) {
  return async () => {
    await refreshProjectIndex(projectId);
  };
}
