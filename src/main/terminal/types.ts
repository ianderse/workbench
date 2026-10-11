import type * as pty from '@lydell/node-pty';
import type { BrowserWindow } from 'electron';
import type { TerminalWorktreeConfig, WindowsShellType } from '../../shared/types';

// Re-export WindowsShellType for backwards compatibility
export type { WindowsShellType } from '../../shared/types';

/**
 * Terminal process tracking
 */
export interface TerminalProcess {
  id: string;
  pty: pty.IPty;
  isCLIMode: boolean;
  projectPath?: string;
  cwd: string;
  claudeProfileId?: string;
  outputBuffer: string;
  title: string;
  /** Associated worktree configuration (persisted across restarts) */
  worktreeConfig?: TerminalWorktreeConfig;
  /** Whether this terminal has a pending Claude resume that should be triggered on activation */
  pendingCLIResume?: boolean;
  /** Whether Claude was invoked with --dangerously-skip-permissions (YOLO mode) */
  dangerouslySkipPermissions?: boolean;
  /** The project's Graphify output directory (its GRAPHIFY_OUT), when the project has a memory graph */
  graphifyOut?: string;
  /** Shell type for Windows (affects command chaining syntax) */
  shellType?: WindowsShellType;
  /** Whether PTY has emitted exit; used to avoid writes/resizes on dead PTYs */
  hasExited?: boolean;
  /**
   * Set while the window follows a running task's session (read-only): the follower gets the
   * keys and the shell's output is held back
   */
  follower?: { handleInput(data: string): void; stop(): void };
  /** The app is restarting the window's CLI (account switch): its exit must not close the window */
  cliRestarting?: boolean;
  /** Last output characters, to find the CLI exit marker when it is split across chunks */
  cliExitTail?: string;
}

/**
 * Rate limit event data
 */
export interface RateLimitEvent {
  terminalId: string;
  resetTime: string;
  detectedAt: string;
  profileId: string;
  suggestedProfileId?: string;
  suggestedProfileName?: string;
  autoSwitchEnabled: boolean;
}

/**
 * OAuth token event data
 */
export interface OAuthTokenEvent {
  terminalId: string;
  profileId?: string;
  email?: string;
  success: boolean;
  message?: string;
  detectedAt: string;
}

/**
 * Terminal creation result
 */
export interface TerminalOperationResult {
  success: boolean;
  error?: string;
  outputBuffer?: string;
}

/**
 * Window getter function type
 */
export type WindowGetter = () => BrowserWindow | null;

/**
 * Terminal info for profile change operations
 */
export interface TerminalProfileChangeInfo {
  id: string;
  cwd: string;
  projectPath?: string;
  claudeProfileId?: string;
  isCLIMode: boolean;
  dangerouslySkipPermissions?: boolean;
}
