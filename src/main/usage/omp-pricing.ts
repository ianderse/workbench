/** OMP catalog cache, independent of frequently changing project usage ledgers. */
import type { OmpModelInfo } from '../../shared/types/omp-detection';
import { detectOmp } from '../agent-backend/omp-detection';
import { appLog } from '../app-logger';

let models: readonly OmpModelInfo[] | undefined;
let pending: Promise<readonly OmpModelInfo[]> | undefined;

/** Read once per app session; explicit Usage refresh retries and updates the catalog. */
export function readOmpPricingModels(refresh = false): Promise<readonly OmpModelInfo[]> {
  if (pending) return pending;
  if (models && !refresh) return Promise.resolve(models);
  pending = (async () => {
    try {
      const result = await detectOmp();
      if (!result.error && result.models.some((model) => model.cost && (model.pricingStatus === 'fixed' || model.pricingStatus === 'free'))) {
        models = result.models;
      }
    } catch (error) {
      appLog.warn('[Usage] Could not refresh the OMP pricing catalog:', error);
    }
    // A failed refresh keeps the last known rates; an unavailable CLI uses built-in rates.
    models ??= [];
    return models;
  })().finally(() => { pending = undefined; });
  return pending;
}
