/** What Settings > Agents knows about the OMP CLI on this machine */

export interface OmpModelInfo {
  /** Provider name in OMP (ollama, lmstudio, openai...) */
  provider: string;
  /** Model id inside the provider */
  id: string;
  /** Value for `omp --model` (provider/id) */
  selector: string;
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
