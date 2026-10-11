
export interface EnvironmentVars {
  [key: string]: string;
}

/**
 * A memory setting from a project's .env (MEMORY_<name>). Projects saved by older versions used
 * GRAPHITI_<name>, which is still read until the project's memory settings are saved again
 */
export function readMemoryEnvVar(vars: EnvironmentVars, name: string): string | undefined {
  return vars[`MEMORY_${name}`] || vars[`GRAPHITI_${name}`] || undefined;
}