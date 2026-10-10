/**
 * Insights module - modular architecture for AI-powered codebase insights
 *
 * This module provides a clean separation of concerns:
 * - config: Environment and configuration management
 * - paths: Path resolution utilities
 * - session-storage: Filesystem persistence layer
 * - session-manager: Session lifecycle management
 * - insights-executor: runs chat turns through Claude Code (claude-code-runner)
 */

export { InsightsConfig } from './config';
export { InsightsPaths } from './paths';
export { SessionStorage } from './session-storage';
export { SessionManager } from './session-manager';
export { InsightsExecutor } from './insights-executor';
