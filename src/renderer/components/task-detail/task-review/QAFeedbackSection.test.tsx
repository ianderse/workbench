/**
 * @vitest-environment jsdom
 */
/**
 * The "Start over" checkbox of the Request changes composer: off by default, so a change
 * request keeps what the task already built in its worktree.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { QAFeedbackSection } from './QAFeedbackSection';
import { TooltipProvider } from '../../ui/tooltip';

describe('QAFeedbackSection', () => {
  const onFeedbackChange = vi.fn();
  const onReject = vi.fn();
  const onStartOverChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderSection(props: Partial<Parameters<typeof QAFeedbackSection>[0]> = {}) {
    return render(
      <TooltipProvider>
        <QAFeedbackSection
          feedback="Use the other module"
          isSubmitting={false}
          onFeedbackChange={onFeedbackChange}
          onReject={onReject}
          onStartOverChange={onStartOverChange}
          {...props}
        />
      </TooltipProvider>
    );
  }

  it('shows Start over unchecked by default', () => {
    renderSection();
    expect(screen.getByRole('checkbox', { name: /start over/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('reports the choice when Start over is ticked', () => {
    renderSection();
    fireEvent.click(screen.getByRole('checkbox', { name: /start over/i }));
    expect(onStartOverChange).toHaveBeenCalledWith(true);
  });

  it('unticks a ticked Start over', () => {
    renderSection({ startOver: true });
    const checkbox = screen.getByRole('checkbox', { name: /start over/i });
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(checkbox);
    expect(onStartOverChange).toHaveBeenCalledWith(false);
  });

  it('leaves the checkbox out when the choice is not handled', () => {
    renderSection({ onStartOverChange: undefined });
    expect(screen.queryByRole('checkbox', { name: /start over/i })).not.toBeInTheDocument();
  });
});
