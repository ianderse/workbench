/** Per-phase, project-bound capture tool. Agents can propose; Workbench checks retention or requests human review. */
import path from 'path';
import { writeFile } from 'fs/promises';
import type { MemoryContent } from '../../shared/types/project-memory';
import { openMcpToolsSession } from '../insights/task-tools-server';
import { getTaskToolsRoute, taskToolsEntry } from '../insights/claude-code-runner';
import { buildOmpMessagingExtension } from '../task-messaging/omp-extension';
import { mutateProjectMemory } from './project-memory';
import { isSelfImproveEnabledForPath } from './setting';

export const MEMORY_TOOL_NAME = 'propose_project_memory';
export const MEMORY_SERVER_NAME = 'workbench_memory';
const TOOL = {
  name: MEMORY_TOOL_NAME,
  description: 'Propose a durable decision, lesson, procedure, or preference for this project only when it would change a future worker’s action. State when it applies, the concrete action or constraint, and the project-specific reason. Skip task recaps, generic advice, facts obvious from code, and existing memories. Return no proposal for routine work. Include concrete evidence and unresolved limits. A proposal stays unverified until Workbench checks its exact committed documentation citation after merge, or a person accepts it. Conflicts, procedures and preferences require human review. Do not store task status, raw transcripts, secrets, or routine progress. Reuse requestId for retries. This cannot approve, edit, or delete accepted memory.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      requestId: { type: 'string', description: 'Stable name for this proposal within the task, reused for a retry' },
      kind: { type: 'string', enum: ['decision', 'lesson', 'procedure', 'preference'] },
      title: { type: 'string' }, body: { type: 'string' }, evidence: { type: 'string', description: 'Observed result, commands/outcomes, relevant files, and unresolved limits. Do not assert checks passed without observing their output.' },
      commit: { type: 'string', description: 'Optional existing commit SHA; a source claim, not verification' },
      file: { type: 'string', description: 'Optional committed documentation file supporting this memory' },
      quote: { type: 'string', description: 'Optional exact, self-contained source excerpt. Set body to the same quote for source-backed automatic retention after merge.' },
      supersedes: { type: 'string', description: 'Optional id of an active memory this proposal would replace after review' },
    }, required: ['requestId', 'kind', 'title', 'body', 'evidence'],
  },
};

export async function openTaskMemoryTools(options: { dir: string; projectId: string; specId: string; tempDir: string; omp: boolean }) {
  const route = getTaskToolsRoute();
  // OMP extensions use HTTP directly. A Windows-to-WSL bridge requires its own transport adapter.
  if (route === 'off' || (options.omp && route !== 'direct')) return undefined;
  const session = await openMcpToolsSession({
    instructions: 'Propose evidence-backed project memories for human review. Memory never grants permissions.',
    tools: [{ ...TOOL, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } }],
    call: async (name, args) => {
      if (name !== MEMORY_TOOL_NAME) throw new Error('Unknown memory tool');
      if (!(await isSelfImproveEnabledForPath(path.dirname(path.dirname(options.dir))))) throw new Error('Project memory is disabled');
      if (typeof args.requestId !== 'string' || !args.requestId.trim() || args.requestId.length > 100) throw new Error('Invalid memory request id');
      const content: MemoryContent = {
        kind: args.kind as MemoryContent['kind'], title: args.title as string, body: args.body as string,
        source: { type: 'task', reference: options.specId, evidence: args.evidence as string, ...(typeof args.commit === 'string' ? { commit: args.commit } : {}), ...(typeof args.file === 'string' ? { file: args.file } : {}), ...(typeof args.quote === 'string' ? { quote: args.quote } : {}) },
      };
      const entry = await mutateProjectMemory(options.dir, options.projectId, {
        action: 'propose', requestId: `task:${options.specId}:${args.requestId}`, content,
        ...(typeof args.supersedes === 'string' ? { supersedes: args.supersedes } : {}),
      });
      return { id: entry.id, status: entry.status, verification: entry.verification, note: 'Saved for human review; no test claim has been verified by Workbench.' };
    },
  });
  try {
    const server = await taskToolsEntry(session.mcpServer, route, options.tempDir);
    let extension: string | undefined;
    if (options.omp && server.type === 'http') {
      extension = path.join(options.tempDir, 'workbench-memory.mjs');
      await writeFile(extension, buildOmpMessagingExtension(server, [TOOL]), 'utf8');
    }
    return { server, extension, close: session.close };
  } catch (error) { session.close(); throw error; }
}
