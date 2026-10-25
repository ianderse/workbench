import { useEffect, useRef, type RefObject } from 'react';
import { useTerminalStore } from '../../stores/terminal-store';

interface UseTerminalEventsOptions {
  terminalId: string;
  // Track deliberate recreation scenarios (e.g., worktree switching)
  // When true, skips auto-removal to allow proper recreation
  isRecreatingRef?: RefObject<boolean>;
  onExit?: (exitCode: number) => void;
  onTitleChange?: (title: string) => void;
}

export function useTerminalEvents({
  terminalId,
  isRecreatingRef,
  onExit,
  onTitleChange,
}: UseTerminalEventsOptions) {
  // Use refs to always have the latest callbacks without re-registering listeners
  // This prevents duplicate listener registration when callbacks change identity
  const onExitRef = useRef(onExit);
  const onTitleChangeRef = useRef(onTitleChange);

  // Keep refs updated with latest callbacks
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  // Handle terminal exit
  useEffect(() => {
    const cleanup = window.electronAPI.onTerminalExit((id, exitCode) => {
      if (id === terminalId) {
        // During deliberate recreation (e.g., worktree switching), skip the normal
        // exit handling to prevent setting status to 'exited' and scheduling removal.
        // The recreation flow will handle status transitions.
        if (isRecreatingRef?.current) {
          onExitRef.current?.(exitCode);
          return;
        }

        const store = useTerminalStore.getState();
        store.setTerminalStatus(terminalId, 'exited');
        // Reset Claude mode when terminal exits - the Claude process has ended
        // setTerminalStatus('exited') already sends SHELL_EXITED to XState (which handles
        // claude_active -> exited transition), so setCLIMode(false) here only updates Zustand
        // (its XState guard skips CLAUDE_EXITED since the machine is already in 'exited')
        const terminal = store.getTerminal(terminalId);
        if (terminal?.isCLIMode) {
          store.setCLIMode(terminalId, false);
        }
        onExitRef.current?.(exitCode);

        // The shell exited (typed `exit`, or Claude Code exited in an agent window): close the
        // window right away, like its close button. Waiting let the grid remount it during its
        // exit grace period, which started a new shell in the same window
        window.electronAPI.destroyTerminal(terminalId).catch(() => {
          // Ignore errors - the PTY is already gone; this removes its persisted session
        });
        store.removeTerminal(terminalId);
      }
    });

    return cleanup;
  }, [terminalId, isRecreatingRef]);

  // Handle terminal title change
  useEffect(() => {
    const cleanup = window.electronAPI.onTerminalTitleChange((id, title) => {
      if (id === terminalId) {
        useTerminalStore.getState().updateTerminal(terminalId, { title });
        onTitleChangeRef.current?.(title);
      }
    });

    return cleanup;
  }, [terminalId]);

  // Handle worktree config change (synced from main process during restoration)
  // This ensures the worktree label appears after terminal recovery
  useEffect(() => {
    const cleanup = window.electronAPI.onTerminalWorktreeConfigChange((id, config) => {
      if (id === terminalId) {
        useTerminalStore.getState().setWorktreeConfig(terminalId, config);
      }
    });

    return cleanup;
  }, [terminalId]);

  // Handle Claude busy state changes (for visual indicator)
  useEffect(() => {
    const cleanup = window.electronAPI.onTerminalClaudeBusy((id, isBusy) => {
      if (id === terminalId) {
        useTerminalStore.getState().setClaudeBusy(terminalId, isBusy);
      }
    });

    return cleanup;
  }, [terminalId]);

  // Handle Claude exit (user closed Claude within terminal, returned to shell)
  useEffect(() => {
    const cleanup = window.electronAPI.onTerminalClaudeExit((id: string) => {
      if (id === terminalId) {
        const store = useTerminalStore.getState();
        const terminal = store.getTerminal(terminalId);
        // Guard: If terminal has already exited, don't set status back to 'running'
        // This handles the race condition where terminal exit and Claude exit events
        // arrive in unexpected order (e.g., user types 'exit' which closes both)
        if (terminal?.status === 'exited') {
          return;
        }
        // Reset Claude mode - Claude has exited but terminal is still running
        // Use setCLIMode which properly sends CLAUDE_EXITED to the XState machine,
        // then clear residual Claude state separately
        store.setCLIMode(terminalId, false);
        store.updateTerminal(terminalId, {
          isClaudeBusy: undefined,
        });
        console.warn('[Terminal] Claude exited, reset mode for terminal:', terminalId);
      }
    });

    return cleanup;
  }, [terminalId]);

  // The Claude Code session the window runs now: the header's Session and Task menus follow it
  useEffect(() => {
    const cleanup = window.electronAPI.onTerminalClaudeSessionChange((id, sessionId) => {
      if (id === terminalId) {
        useTerminalStore.getState().updateTerminal(terminalId, { claudeSessionId: sessionId });
      }
    });

    return cleanup;
  }, [terminalId]);

  // Handle pending Claude resume notification (resumed once its window is shown)
  useEffect(() => {
    const cleanup = window.electronAPI.onTerminalPendingResume((id) => {
      if (id === terminalId) {
        useTerminalStore.getState().setPendingClaudeResume(terminalId, true);
      }
    });

    return cleanup;
  }, [terminalId]);
}
