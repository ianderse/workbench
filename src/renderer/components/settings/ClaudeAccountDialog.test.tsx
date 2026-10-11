/**
 * @vitest-environment jsdom
 */
/**
 * ClaudeAccountDialog: a browser sign-in that never finishes (it failed in the browser) can be
 * cancelled, which stops `claude auth login` and removes the half-created account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../../shared/i18n';
import { ClaudeAccountDialog } from './ClaudeAccountDialog';

const saveClaudeProfile = vi.fn();
// Never settles: the browser sign-in failed and `claude auth login` keeps waiting
const claudeAuthLoginSubprocess = vi.fn(() => new Promise(() => {}));
const cancelClaudeAuthLogin = vi.fn();
const deleteClaudeProfile = vi.fn();

Object.defineProperty(window, 'electronAPI', {
  value: {
    saveClaudeProfile,
    claudeAuthLoginSubprocess,
    cancelClaudeAuthLogin,
    deleteClaudeProfile,
    onClaudeAuthLoginProgress: () => () => {},
  },
  writable: true,
});

describe('ClaudeAccountDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveClaudeProfile.mockResolvedValue({ success: true, data: { id: 'work' } });
    cancelClaudeAuthLogin.mockResolvedValue({ success: true });
    deleteClaudeProfile.mockResolvedValue({ success: true });
  });

  const startSignIn = async (onOpenChange: (open: boolean) => void) => {
    render(<ClaudeAccountDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));
    await waitFor(() => expect(claudeAuthLoginSubprocess).toHaveBeenCalledWith('work'));
  };

  it('keeps Cancel enabled while waiting for the browser and stops the sign-in with it', async () => {
    const onOpenChange = vi.fn();
    await startSignIn(onOpenChange);

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);

    expect(cancelClaudeAuthLogin).toHaveBeenCalledWith('work');
    expect(deleteClaudeProfile).toHaveBeenCalledWith('work');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stops the sign-in when the dialog is closed with Escape', async () => {
    const onOpenChange = vi.fn();
    await startSignIn(onOpenChange);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(cancelClaudeAuthLogin).toHaveBeenCalledWith('work');
    expect(deleteClaudeProfile).toHaveBeenCalledWith('work');
  });
});
