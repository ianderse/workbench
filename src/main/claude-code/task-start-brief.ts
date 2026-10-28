import { git } from '../utils/git-exec';

const MAX_SECTION_CHARS = 1_200;
const MAX_COMMANDS = 8;

function bounded(text: string): string {
  const value = text.trim();
  return value.length <= MAX_SECTION_CHARS ? value : `${value.slice(0, MAX_SECTION_CHARS)}\n[Snapshot truncated; inspect the relevant paths if needed]`;
}

/** Two independent read-only Git inspections replace repeated opening model/tool turns. */
export async function buildTaskStartBrief(options: {
  cwd: string;
  baseBranch: string;
  verification?: readonly string[];
  signal?: AbortSignal;
}): Promise<string> {
  const gitOptions = { cwd: options.cwd, isolated: true, timeout: 5_000, maxBuffer: 64 * 1024, signal: options.signal };
  const [status, diff] = await Promise.allSettled([
    git(['status', '--short', '--branch', '--untracked-files=normal'], gitOptions),
    git(['diff', '--stat', `${options.baseBranch}...HEAD`, '--'], gitOptions),
  ]);
  const statusText = status.status === 'fulfilled' ? bounded(status.value.stdout) || '(no status output)' : 'Unavailable; inspect Git state before changing files';
  const diffText = diff.status === 'fulfilled' ? bounded(diff.value.stdout) || '(no committed differences)' : 'Unavailable; inspect the relevant change before reviewing it';
  const commands = (options.verification ?? []).slice(0, MAX_COMMANDS).map((command) => command.slice(0, 240));
  return `## Phase starting snapshot
Workbench collected this read-only snapshot at the start of this phase. It can become stale as work proceeds; verify state when it affects the next change. Working-tree changes and untracked paths appear in status; the change summary covers committed changes against ${JSON.stringify(options.baseBranch)}.
Git status:
${statusText}
Committed change summary:
${diffText}${commands.length ? `\nSuggested verification commands (not test results):\n${commands.map((command) => `- ${JSON.stringify(command)}`).join('\n')}` : ''}`;
}
