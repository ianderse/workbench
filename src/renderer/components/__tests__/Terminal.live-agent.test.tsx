/**
 * @vitest-environment jsdom
 */
/**
 * Live agent in an agent window: the graph shows next to the terminal only while the setting is
 * on, and switching it never remounts the terminal (its session and scrollback stay)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { Terminal } from '../Terminal';
import { useTerminalStore, type Terminal as TerminalState } from '../../stores/terminal-store';
import { useSettingsStore } from '../../stores/settings-store';

const fit = vi.fn(() => true);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } })
}));
vi.mock('@dnd-kit/core', () => ({ useDroppable: () => ({ setNodeRef: () => {} }) }));
vi.mock('../terminal/useXterm', () => ({
  useXterm: () => ({
    terminalRef: useRef<HTMLDivElement>(null),
    xtermRef: { current: null },
    fit,
    write: vi.fn(),
    writeln: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    cols: 80,
    rows: 24
  })
}));
vi.mock('../terminal/usePtyProcess', () => ({
  usePtyProcess: () => ({ prepareForRecreate: vi.fn(), resetForRecreate: vi.fn() })
}));
vi.mock('../terminal/useTerminalEvents', () => ({ useTerminalEvents: () => {} }));
vi.mock('../terminal/TerminalHeader', () => ({ TerminalHeader: () => null }));
vi.mock('../terminal/CreateWorktreeDialog', () => ({ CreateWorktreeDialog: () => null }));
vi.mock('../live-agent/LiveAgentGraph', () => ({
  default: ({ cwd }: { cwd: string }) => <div data-testid="live-agent-graph">{cwd}</div>
}));

function terminal(isCLIMode: boolean): TerminalState {
  return {
    id: 't1',
    title: 'Claude',
    status: 'running',
    cwd: '/work/app',
    createdAt: new Date(),
    isCLIMode,
    projectPath: '/work/app'
  };
}

function setLiveAgent(liveAgent: boolean) {
  act(() => {
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, liveAgent } }));
  });
}

function renderTerminal() {
  return render(
    <Terminal id="t1" cwd="/work/app" projectPath="/work/app" isActive onClose={() => {}} onActivate={() => {}} />
  );
}

/** The element xterm is mounted in */
const xtermHost = (container: HTMLElement) => container.querySelector('.h-full.w-full');

describe('Terminal with Live agent', () => {
  beforeEach(() => {
    fit.mockClear();
    (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({}, {
      get: () => vi.fn(() => Promise.resolve({ success: true }))
    });
    useTerminalStore.setState({ terminals: [terminal(true)] });
    setLiveAgent(false);
  });

  it('shows no graph while the setting is off', () => {
    renderTerminal();
    expect(screen.queryByTestId('live-agent-graph')).not.toBeInTheDocument();
  });

  it('shows the graph of the window directory when switched on, and keeps the terminal mounted', async () => {
    const { container } = renderTerminal();
    const host = xtermHost(container);
    expect(host).not.toBeNull();

    setLiveAgent(true);
    expect(await screen.findByTestId('live-agent-graph')).toHaveTextContent('/work/app');
    expect(xtermHost(container)).toBe(host);
    // The terminal is refit to its new width
    await waitFor(() => expect(fit).toHaveBeenCalled());

    fit.mockClear();
    setLiveAgent(false);
    expect(screen.queryByTestId('live-agent-graph')).not.toBeInTheDocument();
    expect(xtermHost(container)).toBe(host);
    await waitFor(() => expect(fit).toHaveBeenCalled());
  });

  it('shows no graph in a plain terminal window', () => {
    useTerminalStore.setState({ terminals: [terminal(false)] });
    setLiveAgent(true);
    renderTerminal();
    expect(screen.queryByTestId('live-agent-graph')).not.toBeInTheDocument();
  });
});
