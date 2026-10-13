/**
 * Configuration for the insights service.
 * Insights runs through Claude Code, which resolves its own credentials (see
 * `resolveClaudeEnv`), so nothing needs configuring; `configure()` is kept for callers.
 */
export class InsightsConfig {
  configure(_pythonPath?: string, _autoBuildSourcePath?: string): void {
    // Nothing to configure
  }
}
