import { describe, it, expect, vi, beforeEach } from 'vitest';

import { codebaseGraphTool } from '../codebase-graph';
import { getSessionToolNames } from '../../registry';
import type { ToolContext } from '../../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('../../truncation', () => ({
  truncateToolOutput: vi.fn((output: string) => ({
    content: output,
    wasTruncated: false,
    originalSize: Buffer.byteLength(output, 'utf-8'),
  })),
}));

import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const graph = '/test/project/.auto-claude/memory/graphify-out/graph.json';

const baseContext = {
  cwd: '/test/project',
  projectDir: '/test/project',
  specDir: '/test/specs/001',
  securityProfile: {},
  graphify: { cli: '/usr/bin/graphify', graph },
} as unknown as ToolContext;

/** Make the mocked graphify command print the given output (or fail with it) */
function mockGraphify(stdout: string, fail = false) {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: unknown, result?: unknown) => void;
    if (fail) callback(Object.assign(new Error('failed'), { stderr: stdout }));
    else callback(null, { stdout, stderr: '' });
  }) as unknown as typeof execFile);
}

/** The arguments graphify was run with */
function graphifyArgs(): string[] {
  return vi.mocked(execFile).mock.calls[0][1] as string[];
}

const run = (input: Record<string, unknown>, context: ToolContext = baseContext) =>
  codebaseGraphTool.config.execute(input as never, context);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodebaseGraph tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries the project graph with a question and token budget', async () => {
    mockGraphify('TaskLogService -> writes task_logs.json');
    const result = await run({ action: 'query', question: 'how are task logs written?' });
    expect(result).toBe('TaskLogService -> writes task_logs.json');
    expect(vi.mocked(execFile).mock.calls[0][0]).toBe('/usr/bin/graphify');
    expect(graphifyArgs()).toEqual(['query', 'how are task logs written?', '--budget', '2000', '--graph', graph]);
  });

  it('maps explain, affected, path and hubs to graphify commands', async () => {
    mockGraphify('ok');
    await run({ action: 'explain', symbol: 'AgentManager' });
    expect(graphifyArgs()).toEqual(['explain', 'AgentManager', '--graph', graph]);

    vi.mocked(execFile).mockClear();
    await run({ action: 'affected', symbol: 'AgentManager' });
    expect(graphifyArgs()).toEqual(['affected', 'AgentManager', '--graph', graph]);

    vi.mocked(execFile).mockClear();
    await run({ action: 'path', from: 'Sidebar', to: 'AgentManager' });
    expect(graphifyArgs()).toEqual(['path', 'Sidebar', 'AgentManager', '--undirected', '--graph', graph]);

    vi.mocked(execFile).mockClear();
    await run({ action: 'hubs' });
    expect(graphifyArgs()).toEqual(['god-nodes', '--top', '15', '--graph', graph]);
  });

  it('asks for the inputs an action needs without running graphify', async () => {
    expect(await run({ action: 'query' })).toBe('Error: query needs a question');
    expect(await run({ action: 'explain' })).toBe('Error: explain needs a symbol');
    expect(await run({ action: 'path', from: 'A' })).toBe('Error: path needs from and to symbols');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports a failed search with graphify output', async () => {
    mockGraphify('no node matching "Nope"', true);
    expect(await run({ action: 'explain', symbol: 'Nope' })).toBe(
      'Error: the code graph search failed: no node matching "Nope"'
    );
  });

  it('refuses when the project has no graph', async () => {
    const result = await run({ action: 'hubs' }, { ...baseContext, graphify: undefined });
    expect(result).toBe('Error: this project has no code graph');
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('getSessionToolNames', () => {
  it('adds CodebaseGraph for agents that search code when the project has a graph', () => {
    expect(getSessionToolNames(['Read', 'Glob', 'Grep'], baseContext)).toEqual(['Read', 'Glob', 'Grep', 'CodebaseGraph']);
  });

  it('leaves the tools alone without a graph or without Grep', () => {
    expect(getSessionToolNames(['Read', 'Grep'], { ...baseContext, graphify: undefined })).toEqual(['Read', 'Grep']);
    expect(getSessionToolNames(['Write'], baseContext)).toEqual(['Write']);
  });
});
