/**
 * Application configuration constants
 * Default settings, file paths, and project structure
 */

// ============================================
// Terminal Timing Constants
// ============================================

/** Delay for DOM updates before terminal operations (refit, resize).
 * Must be long enough for dnd-kit CSS transitions to complete after drag-drop reorder.
 * 50ms was too short, causing xterm to fit into containers with zero/invalid dimensions. */
export const TERMINAL_DOM_UPDATE_DELAY_MS = 250;

/** Grace period before cleaning up error panel constraints after panel removal */
export const PANEL_CLEANUP_GRACE_PERIOD_MS = 150;

// ============================================
// UI Scale Constants
// ============================================

/**
 * Height (px) of the window-controls strip on Windows/Linux, where the OS title bar is hidden
 * and Electron draws minimize/maximize/close over the top-right corner of the app
 */
export const TITLE_BAR_OVERLAY_HEIGHT = 40;


// ============================================
// Default App Settings
// ============================================

// Agent terminals per project. The cap guards against excessive memory use from terminal
// buffers (~1MB each) and PTY process resource exhaustion.
export const DEFAULT_MAX_TERMINALS = 12;
export const MIN_TERMINALS = 1;
export const MAX_TERMINALS_LIMIT = 24;

export const DEFAULT_APP_SETTINGS = {
  theme: 'system' as const,
  colorTheme: 'default' as const,
  pythonPath: undefined as string | undefined,
  nodePath: undefined as string | undefined,
  gitPath: undefined as string | undefined,
  githubCLIPath: undefined as string | undefined,
  gitlabCLIPath: undefined as string | undefined,
  autoBuildPath: undefined as string | undefined,
  autoUpdateAutoBuild: true,
  maxTerminals: DEFAULT_MAX_TERMINALS,
  notifications: {
    onTaskComplete: true,
    onTaskFailed: true,
    onReviewNeeded: true,
    sound: false
  },
  // API key for OpenAI memory embeddings (used as the default for all projects)
  globalOpenAIApiKey: undefined as string | undefined,
  // Interface font (bundled Anthropic Sans)
  interfaceFont: 'anthropic-sans' as const,
  // Graph page colors: one muted color (Graphify's community colors with 'colorful')
  graphStyle: 'plain' as const,
  // Windows shell: native tools with PowerShell agent windows ('wsl' runs everything in WSL)
  windowsShell: 'pwsh' as const,
  // Log order setting for task detail view (default chronological - oldest first)
  logOrder: 'chronological' as const,
  // Beta updates opt-in (receive pre-release versions)
  betaUpdates: false,
  // Auto-name Claude terminals based on initial message (enabled by default)
  // GPU acceleration for terminal rendering
  // Default to 'off' until WebGL stability is proven across all GPU drivers.
  // Users can opt-in via Settings > Display > GPU Acceleration.
  gpuAcceleration: 'off' as const
};

// ============================================
// Default Project Settings
// ============================================

export const DEFAULT_PROJECT_SETTINGS = {
  model: 'opus',
  notifications: {
    onTaskComplete: true,
    onTaskFailed: true,
    onReviewNeeded: true,
    sound: false
  },
  // Include CLAUDE.md instructions in agent context (enabled by default)
  useClaudeMd: true
};

// ============================================
// Auto Build File Paths
// ============================================

/**
 * Folders inside a project's .workbench data directory. Older versions used other names
 * (LEGACY_DATA_DIR_NAMES); projects are migrated when the app starts or a project is added.
 */
export const DATA_DIR_NAMES = {
  /** One folder per task (task_metadata.json, implementation_plan.json, claude_run.json, logs) */
  tasks: 'tasks',
  /** The project's Graphify knowledge graph */
  knowledge: 'knowledge',
  /** Claude page (Insights) chat sessions and attachments */
  chats: 'chats',
} as const;

/** Names the data folders had before (tasks were "specs", knowledge "memory", chats "insights") */
export const LEGACY_DATA_DIR_NAMES: Record<keyof typeof DATA_DIR_NAMES, string> = {
  tasks: 'specs',
  knowledge: 'memory',
  chats: 'insights',
};

// File paths relative to project
// IMPORTANT: All paths use .workbench/ (the installed instance), NOT workbench/ (source code)
export const AUTO_BUILD_PATHS = {
  SPECS_DIR: `.workbench/${DATA_DIR_NAMES.tasks}`,
  IMPLEMENTATION_PLAN: 'implementation_plan.json',
  SPEC_FILE: 'spec.md',
  QA_REPORT: 'qa_report.md',
  BUILD_PROGRESS: 'build-progress.txt',
  CONTEXT: 'context.json',
  REQUIREMENTS: 'requirements.json'
} as const;

/**
 * Get the tasks directory path (relative to the project): one folder per task in
 * .workbench/tasks/ (the project's data directory).
 */
export function getSpecsDir(autoBuildPath: string | undefined): string {
  const basePath = autoBuildPath || '.workbench';
  return `${basePath}/${DATA_DIR_NAMES.tasks}`;
}
