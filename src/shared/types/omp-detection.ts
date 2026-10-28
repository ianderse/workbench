/** What Settings > Agents knows about the OMP CLI on this machine */

/** OMP catalog rates in USD per million tokens, not a recorded charge */
export interface OmpModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type OmpModelPricingStatus = 'fixed' | 'free' | 'included' | 'variable' | 'unknown';

export interface OmpModelInfo {
  /** Provider name in OMP (ollama, lmstudio, openai...) */
  provider: string;
  /** Model id inside the provider */
  id: string;
  /** Value for `omp --model` (provider/id) */
  selector: string;
  name?: string;
  /** Base rates reported by `omp models --json`; unknown pricing can contain zeroes */
  cost?: OmpModelCost;
  pricingStatus?: OmpModelPricingStatus;
}

export interface OmpDetection {
  installed: boolean;
  /** Resolved executable path, when found */
  path?: string;
  version?: string;
  models: OmpModelInfo[];
  /** Model roles of the user's OMP config (`modelRoles`): role name -> model selector */
  roles?: Record<string, string>;
  /** Why the model list is empty or the CLI was not usable */
  error?: string;
}
