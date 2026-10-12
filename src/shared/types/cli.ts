/**
 * CLI Tool Types
 *
 * Shared types for CLI tool detection and management.
 * Used by both main process (cli-tool-manager) and renderer process (Settings UI).
 */

/**
 * Result of tool detection operation
 * Contains path, version, and metadata about detection source
 */
export interface ToolDetectionResult {
  found: boolean;
  path?: string;
  version?: string;
  source:
    | 'user-config'
    | 'venv'
    | 'homebrew'
    | 'nvm'
    | 'system-path'
    | 'bundled'
    | 'fallback';
  message: string;
}

/**
 * Claude Code CLI version information
 * Used for version checking and update prompts
 */
export interface ClaudeCodeVersionInfo {
  /** Currently installed version, null if not installed */
  installed: string | null;
  /** Latest version available from npm registry */
  latest: string;
  /** True if installed version is older than latest */
  isOutdated: boolean;
  /** Path to Claude CLI binary if found */
  path?: string;
  /** Full detection result with source information */
  detectionResult: ToolDetectionResult;
}

/**
 * Available Claude Code CLI versions
 * Used for version rollback feature
 */
export interface ClaudeCodeVersionList {
  /** List of available versions, sorted newest first */
  versions: string[];
  /** npm release channels and the version each points to (e.g. latest, next, stable) */
  distTags?: Record<string, string>;
}

/**
 * Information about a detected Claude CLI installation
 * Used for displaying available installations and allowing user selection
 */
export interface ClaudeInstallationInfo {
  /** Full path to the Claude CLI executable */
  path: string;
  /** Version string if detected, null if validation failed */
  version: string | null;
  /** Source of detection (user-config, homebrew, system-path, nvm, etc.) */
  source: ToolDetectionResult['source'];
  /** Whether this is the currently active/configured installation */
  isActive: boolean;
}

/**
 * List of all detected Claude CLI installations
 */
export interface ClaudeInstallationList {
  /** All detected Claude CLI installations */
  installations: ClaudeInstallationInfo[];
  /** Path to the currently active installation (from settings or auto-detected) */
  activePath: string | null;
}

/**
 * Graphify CLI (https://github.com/Graphify-Labs/graphify): installed vs latest version
 */
export interface GraphifyVersionInfo {
  /** Installed version, null when the graphify command is not found */
  installed: string | null;
  /** Latest version on PyPI, null when it could not be fetched */
  latest: string | null;
  /** Whether a newer version than the installed one is available */
  isOutdated: boolean;
}

/**
 * A project's memory graph, built by Graphify into .auto-claude/knowledge
 */
export interface GraphifyIndexInfo {
  nodes: number;
  edges: number;
  communities: number;
  /** ISO timestamp of the last build */
  builtAt: string;
  /** Graphify version that built it */
  version: string | null;
}

/** A node of a project's memory graph (Graphify's graph.json, trimmed for display) */
export interface GraphifyGraphNode {
  id: string;
  label: string;
  /** Cluster the node belongs to */
  community?: number;
  sourceFile?: string;
  sourceLocation?: string;
}

/** An edge of a project's memory graph */
interface GraphifyGraphLink {
  source: string;
  target: string;
  /** e.g. calls, imports, contains */
  relation?: string;
  /** EXTRACTED, INFERRED, ...; Graphify draws non-extracted links fainter */
  confidence?: string;
}

export interface GraphifyGraph {
  nodes: GraphifyGraphNode[];
  links: GraphifyGraphLink[];
}
