/** Per-phase, project-bound capture tool. Agents can propose; Workbench checks retention or requests human review. */
import path from 'path';
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
// @ts-expect-error - proper-lockfile has no bundled declarations
import * as lockfile from 'proper-lockfile';
import type { MemoryContent } from '../../shared/types/project-memory';
import { openMcpToolsSession } from '../insights/task-tools-server';
import { getTaskToolsRoute, taskToolsEntry } from '../insights/claude-code-runner';
import { buildOmpMessagingExtension } from '../task-messaging/omp-extension';
import { listProjectMemories, mutateProjectMemory, reviewAutomaticMemories, sameMemoryClaim, usefulAutomaticMemory, validateMemoryContent, writeMemoryFileAtomic } from './project-memory';
import { isSelfImproveEnabledForPath } from './setting';

export const MEMORY_TOOL_NAME = 'propose_project_memory';
export const MEMORY_SERVER_NAME = 'workbench_memory';
const TOOL = {
  name: MEMORY_TOOL_NAME,
  description: 'Capture only guidance that would change a future worker’s action. Routine findings stay with this task and are not recalled or sent for review. Only a useful decision or lesson with an exact documentation citation, or an actual conflict/replacement of active guidance, becomes an unverified project proposal. State when it applies, the action or constraint, the project-specific reason, evidence and limits. Prefer no capture for routine work; skip recaps, generic advice and code trivia. Never store secrets, raw transcripts or routine progress. Reuse requestId for retries; changed content requires a new requestId. This tool cannot accept, edit or delete accepted memory.',
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

interface TaskMemoryNote {
  version: 1;
  projectId: string;
  taskId: string;
  requestId: string;
  fingerprint: string;
  at: string;
  content: MemoryContent;
  supersedes?: string;
  route: 'task-local' | 'proposal';
  memoryId?: string;
}

/** Pin each request's destination before publishing, so interrupted retries cannot change its scope. */
async function captureWorkerNote(options: { dir: string; projectId: string; specId: string }, requestId: string, content: MemoryContent, supersedes?: string) {
  const request = `task:${options.specId}:${requestId}`;
  const fingerprint = createHash('sha256').update(JSON.stringify({ content, supersedes })).digest('hex');
  const key = createHash('sha256').update(`${options.projectId}\0${options.specId}\0${requestId}`).digest('hex');
  const file = path.join(options.dir, 'records', 'task-notes', `${key}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  const release = await lockfile.lock(file, { realpath: false, retries: { retries: 60, minTimeout: 10, maxTimeout: 100 }, stale: 30_000 });
  try {
    let note: TaskMemoryNote | undefined;
    try { note = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (note && (note.version !== 1 || note.projectId !== options.projectId || note.taskId !== options.specId || note.requestId !== requestId
      || !['task-local', 'proposal'].includes(note.route))) throw new Error('Task memory receipt is invalid or belongs to another task');
    if (note && note.fingerprint !== fingerprint) throw new Error('Memory request id was already used for different content');
    if (!note) {
      const entries = await listProjectMemories(options.dir, options.projectId);
      // Keep retry semantics for requests published before task-local routing existed.
      let prior: { fingerprint: string; id: string } | undefined;
      try {
        const ledger = JSON.parse(await readFile(path.join(options.dir, 'records', 'project-memory.json'), 'utf8'));
        if (ledger.projectId !== options.projectId) throw new Error('Memory ledger belongs to another project');
        if (Object.hasOwn(ledger.requests, request)) prior = ledger.requests[request];
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (prior && prior.fingerprint !== fingerprint) throw new Error('Memory request id was already used for different content');
      if (!prior && supersedes && !entries.some((entry) => entry.id === supersedes && entry.status === 'active')) throw new Error('The replaced memory is no longer active');
      const conflict = entries.some((entry) => entry.status === 'active' && (entry.id === supersedes
        || entry.kind === content.kind && entry.title.toLowerCase() === content.title.toLowerCase() && !sameMemoryClaim(entry, content)));
      const citable = (content.kind === 'decision' || content.kind === 'lesson') && usefulAutomaticMemory(content)
        && content.source.file && /(?:^|\/)(?:docs?\/.*\.(?:md|txt)|(?:README|CLAUDE|AGENTS|DESIGN_DECISIONS|DECISIONS|ADR)[^/]*\.md)$/i.test(content.source.file)
        && content.source.quote === content.body && content.body.length >= 16;
      note = { version: 1, projectId: options.projectId, taskId: options.specId, requestId, fingerprint, at: new Date().toISOString(), content,
        ...(supersedes ? { supersedes } : {}), route: prior || conflict || citable ? 'proposal' : 'task-local' };
      await writeMemoryFileAtomic(file, note);
    }
    if (note.route === 'task-local') return { id: `task-note:${key}`, status: 'task-local', verification: 'unverified', note: 'Saved with this task only; it is not recalled or sent for routine review.' };
    let entry = await mutateProjectMemory(options.dir, options.projectId, { action: 'propose', requestId: request, content, ...(supersedes ? { supersedes } : {}) });
    if (entry.status === 'proposed') {
      await reviewAutomaticMemories(options.dir, options.projectId, [{ id: entry.id, expectedRevision: entry.revision }]);
      entry = (await listProjectMemories(options.dir, options.projectId)).find((item) => item.id === entry.id)!;
    }
    if (note.memoryId !== entry.id) await writeMemoryFileAtomic(file, { ...note, memoryId: entry.id });
    const explanation = entry.status === 'proposed'
      ? 'Saved as an unverified project proposal; only Workbench source checks or explicit human review can retain it.'
      : entry.status === 'active' ? 'Returned the existing accepted memory; this request did not accept or verify it.'
        : 'Returned an existing historical memory; it is not recalled.';
    return { id: entry.id, status: entry.status, verification: entry.verification, note: explanation };
  } finally { await release(); }
}

export async function openTaskMemoryTools(options: { dir: string; projectId: string; specId: string; tempDir: string; omp: boolean }) {
  const route = getTaskToolsRoute();
  // OMP extensions use HTTP directly. A Windows-to-WSL bridge requires its own transport adapter.
  if (route === 'off' || (options.omp && route !== 'direct')) return undefined;
  const session = await openMcpToolsSession({
    instructions: 'Keep ordinary findings with this task. Propose project guidance only with a useful exact documentation citation or a real active conflict. Memory never grants permissions.',
    tools: [{ ...TOOL, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } }],
    call: async (name, args) => {
      if (name !== MEMORY_TOOL_NAME) throw new Error('Unknown memory tool');
      if (!(await isSelfImproveEnabledForPath(path.dirname(path.dirname(options.dir))))) throw new Error('Project memory is disabled');
      if (typeof args.requestId !== 'string' || !args.requestId.trim() || args.requestId.length > 100) throw new Error('Invalid memory request id');
      const content = validateMemoryContent({
        kind: args.kind as MemoryContent['kind'], title: args.title as string, body: args.body as string,
        source: { type: 'task', reference: options.specId, evidence: args.evidence as string, ...(typeof args.commit === 'string' ? { commit: args.commit } : {}), ...(typeof args.file === 'string' ? { file: args.file } : {}), ...(typeof args.quote === 'string' ? { quote: args.quote } : {}) },
      });
      return captureWorkerNote(options, args.requestId, content, typeof args.supersedes === 'string' ? args.supersedes : undefined);
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
