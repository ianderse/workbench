/**
 * Codebase Graph Tool
 * ===================
 *
 * Searches the project's code knowledge graph (Graphify, built into .auto-claude/memory) with the
 * graphify CLI: questions, symbol explanations, paths between symbols, change impact and the most
 * connected symbols. Only offered to agents when the project's "Use Graphify" setting is on and the
 * project has a graph (ToolContext.graphify).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod/v3';

import { requiresShell } from '../../../platform';
import { Tool } from '../define';
import { ToolPermission } from '../types';
import { truncateToolOutput } from '../truncation';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 60_000;
/** Token budget for `query` answers when the agent doesn't ask for one */
const DEFAULT_BUDGET = 2000;
const MAX_BUDGET = 8000;
const HUB_COUNT = 15;

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  action: z
    .enum(['query', 'explain', 'path', 'affected', 'hubs'])
    .describe(
      'query: answer a question about the code; explain: a symbol and what it links to; path: how two symbols connect; affected: what a change to a symbol can impact; hubs: the most connected symbols',
    ),
  question: z.string().optional().describe('For query: the question, e.g. "how are task logs written?"'),
  symbol: z
    .string()
    .optional()
    .describe('For explain and affected: the symbol (function, class, type or file name), e.g. "TaskLogService"'),
  from: z.string().optional().describe('For path: the first symbol'),
  to: z.string().optional().describe('For path: the second symbol'),
  budget: z
    .number()
    .int()
    .min(200)
    .max(MAX_BUDGET)
    .optional()
    .describe(`For query: the most tokens to return (default ${DEFAULT_BUDGET})`),
});

type Input = z.infer<typeof inputSchema>;

/** graphify arguments for an action, or an error message when a required input is missing */
function buildArgs(input: Input, graph: string): string[] | string {
  switch (input.action) {
    case 'query':
      if (!input.question) return 'Error: query needs a question';
      return ['query', input.question, '--budget', String(input.budget ?? DEFAULT_BUDGET), '--graph', graph];
    case 'explain':
      if (!input.symbol) return 'Error: explain needs a symbol';
      return ['explain', input.symbol, '--graph', graph];
    case 'affected':
      if (!input.symbol) return 'Error: affected needs a symbol';
      return ['affected', input.symbol, '--graph', graph];
    case 'path':
      if (!input.from || !input.to) return 'Error: path needs from and to symbols';
      return ['path', input.from, input.to, '--undirected', '--graph', graph];
    case 'hubs':
      return ['god-nodes', '--top', String(HUB_COUNT), '--graph', graph];
  }
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const codebaseGraphTool = Tool.define({
  metadata: {
    name: 'CodebaseGraph',
    description:
      "Search the project's code knowledge graph (symbols, files and how they call, import and use each other). Use it before Grep or reading files to find where something lives and how it connects: ask a question (query), look up a symbol (explain), connect two symbols (path), see what a change impacts (affected) or list the core of the architecture (hubs). Results cite source files and lines; read them to confirm details, since code changed after the graph was built is not in it.",
    permission: ToolPermission.ReadOnly,
    executionOptions: { timeoutMs: TIMEOUT_MS, allowBackground: false },
  },
  inputSchema,
  execute: async (input, context) => {
    if (!context.graphify) return 'Error: this project has no code graph';
    const args = buildArgs(input, context.graphify.graph);
    if (typeof args === 'string') return args;

    try {
      const { stdout, stderr } = await execFileAsync(context.graphify.cli, args, {
        cwd: context.projectDir,
        encoding: 'utf-8',
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        shell: requiresShell(context.graphify.cli),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        signal: context.abortSignal,
      });
      const output = stdout.trim() || stderr.trim() || 'No results';
      return truncateToolOutput(output, 'CodebaseGraph', context.projectDir).content;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      const details = (failure.stdout || failure.stderr || failure.message || String(error)).trim();
      return `Error: the code graph search failed: ${details}`;
    }
  },
});
