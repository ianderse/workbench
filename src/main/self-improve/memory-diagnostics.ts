/** Read-only, bounded observations for evaluating memory; never a productivity score. */
import { lstat, open, readdir } from 'fs/promises';
import path from 'path';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ');
const boundedLimit = (value: number | undefined, fallback: number, ceiling: number): number => value === undefined ? fallback : Math.max(1, Math.min(ceiling, Math.floor(Number.isFinite(value) ? value : fallback)));

export interface MemoryDiagnosticsOptions {
  projectPath: string;
  autoBuildPath?: string;
  maxTasks?: number;
  maxPacketsPerTask?: number;
  maxCaptureJobs?: number;
  maxTaskNotes?: number;
}

type Exposure = 'unknown' | 'prepared-empty-only' | 'prepared-nonempty-only' | 'mixed-prepared-contexts';
interface ObservedTask {
  taskId: string;
  exposure: Exposure;
  packets: number;
  runRecordPresent: boolean;
  backend: string | null;
  recordedPhaseErrors: number | null;
  recordedReviewRounds: number | null;
  validation: { status: string | null; evidence: 'model-reported' };
  review: { status: string | null; evidence: 'model-reported' };
  outcomeAttribution: 'not-linked-to-context-receipts';
}
interface ObservedPacket { taskId: string; at: number; bytes: number; empty: boolean; items: Array<{ id: string; title: string }> }

export async function readProjectMemoryDiagnostics(options: MemoryDiagnosticsOptions) {
  const root = path.resolve(options.projectPath);
  const build = path.resolve(root, options.autoBuildPath || '.workbench');
  if (build !== root && !build.startsWith(root + path.sep)) throw new Error('Task data must be inside the project');
  const limits = {
    tasks: boundedLimit(options.maxTasks, 50, 500),
    packetsPerTask: boundedLimit(options.maxPacketsPerTask, 40, 200),
    captureJobs: boundedLimit(options.maxCaptureJobs, 500, 2000),
    taskNotes: boundedLimit(options.maxTaskNotes, 500, 2000),
    ledgerBytes: 8_000_000, recordBytes: 512_000, packetBytes: 64_000,
  };
  const issues: Array<{ file: string; reason: string }> = [];
  let issueCount = 0;
  const issue = (file: string, reason: string) => { issueCount++; if (issues.length < 20) issues.push({ file: path.relative(root, file), reason }); };
  const files = async (dir: string, directories = false): Promise<string[]> => {
    try {
      if (!(await lstat(dir)).isDirectory()) { issue(dir, 'Not a regular directory; symlinks are not followed'); return []; }
      return (await readdir(dir, { withFileTypes: true })).filter((entry) => directories ? entry.isDirectory() : entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue(dir, 'Directory could not be read'); return []; }
  };
  const json = async (file: string, maxBytes: number): Promise<RecordValue | undefined> => {
    try {
      if (!(await lstat(file)).isFile()) { issue(file, 'Not a regular file; symlinks are not followed'); return; }
      const handle = await open(file, 'r');
      try {
        if ((await handle.stat()).size > maxBytes) { issue(file, 'File exceeds diagnostic read limit'); return; }
        const buffer = Buffer.alloc(maxBytes + 1);
        let size = 0;
        while (size < buffer.length) {
          const result = await handle.read(buffer, size, buffer.length - size, size);
          if (!result.bytesRead) break;
          size += result.bytesRead;
        }
        if (size > maxBytes) { issue(file, 'File exceeds diagnostic read limit'); return; }
        const value = record(JSON.parse(buffer.subarray(0, size).toString('utf8')));
        if (!value) issue(file, 'Invalid JSON record');
        return value;
      } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue(file, 'Record could not be read or parsed'); return; }
  };

  const memoryDir = path.join(root, '.workbench', 'compeng', 'records');
  const ledger = await json(path.join(memoryDir, 'project-memory.json'), limits.ledgerBytes);
  const ledgerValid = !!ledger && ledger.version === 1 && typeof ledger.projectId === 'string' && Array.isArray(ledger.entries);
  if (ledger && !ledgerValid) issue(path.join(memoryDir, 'project-memory.json'), 'Invalid memory ledger shape');
  const entries = ledgerValid ? (ledger.entries as unknown[]).map(record).filter((entry): entry is RecordValue => !!entry) : [];
  const published = new Set<string>();
  for (const entry of entries) {
    for (const revision of [entry, ...(Array.isArray(entry.history) ? entry.history.map(record).filter((item): item is RecordValue => !!item) : [])]) {
      const source = record(revision.source);
      if (source?.type === 'task' && typeof source.reference === 'string' && typeof revision.body === 'string') published.add(`${source.reference}\0${normalize(revision.body)}`);
    }
  }

  const tasksDir = path.join(build, 'tasks');
  const taskNames = await files(tasksDir, true);
  const tasks: ObservedTask[] = [];
  const packets: ObservedPacket[] = [];
  let packetFilesOmitted = 0;
  for (const taskId of taskNames.slice(0, limits.tasks)) {
    const dir = path.join(tasksDir, taskId);
    const run = await json(path.join(dir, 'claude_run.json'), limits.recordBytes);
    const names = await files(path.join(dir, 'memory-context'));
    packetFilesOmitted += Math.max(0, names.length - limits.packetsPerTask);
    const ownPackets: ObservedPacket[] = [];
    for (const name of names.slice(0, limits.packetsPerTask)) {
      const file = path.join(dir, 'memory-context', name);
      const packet = await json(file, limits.packetBytes);
      if (!packet) continue;
      const items = Array.isArray(packet.items) ? packet.items.map(record) : undefined;
      if (packet.version !== 1 || typeof packet.projectId !== 'string' || packet.taskId !== taskId || (ledgerValid && packet.projectId !== ledger.projectId)
        || typeof packet.prompt !== 'string' || !items || items.some((item) => !item || typeof item.id !== 'string' || typeof item.title !== 'string')
        || !Number.isFinite(Date.parse(text(packet.at) ?? '')) || (items.length === 0) !== (packet.prompt === '')) {
        issue(file, 'Invalid, inconsistent or foreign context receipt'); continue;
      }
      const observed: ObservedPacket = { taskId, at: Date.parse(packet.at as string), bytes: Buffer.byteLength(packet.prompt), empty: items.length === 0,
        items: items.map((item) => ({ id: item!.id as string, title: item!.title as string })) };
      ownPackets.push(observed); packets.push(observed);
    }
    const empty = ownPackets.some((packet) => packet.empty), nonempty = ownPackets.some((packet) => !packet.empty);
    tasks.push({ taskId, exposure: empty && nonempty ? 'mixed-prepared-contexts' : nonempty ? 'prepared-nonempty-only' : empty ? 'prepared-empty-only' : 'unknown',
      packets: ownPackets.length, runRecordPresent: !!run, backend: text(run?.backend) ?? null,
      recordedPhaseErrors: Array.isArray(run?.phases) ? run.phases.map(record).filter((phase) => phase?.isError === true).length : null,
      recordedReviewRounds: Array.isArray(run?.reviewRounds) ? run.reviewRounds.length : null,
      validation: { status: text(record(run?.validation)?.status) ?? null, evidence: 'model-reported' },
      review: { status: text(record(run?.reviewVerdict)?.status) ?? null, evidence: 'model-reported' },
      outcomeAttribution: 'not-linked-to-context-receipts' });
  }

  const captureFiles = await files(path.join(memoryDir, 'captures'));
  let candidateCount = 0, taskLocalCandidates = 0, captureJobsRead = 0;
  for (const name of captureFiles.slice(0, limits.captureJobs)) {
    const job = await json(path.join(memoryDir, 'captures', name), limits.recordBytes);
    if (!job || job.version !== 1 || typeof job.taskId !== 'string' || !Array.isArray(job.candidates)) continue;
    captureJobsRead++;
    for (const candidate of job.candidates.map(record)) {
      if (!candidate || typeof candidate.body !== 'string') continue;
      candidateCount++;
      if (!published.has(`${job.taskId}\0${normalize(candidate.body)}`)) taskLocalCandidates++;
    }
  }
  const noteFiles = await files(path.join(memoryDir, 'task-notes'));
  let taskLocalNotes = 0, proposalNotes = 0, invalidNotes = 0;
  for (const name of noteFiles.slice(0, limits.taskNotes)) {
    const file = path.join(memoryDir, 'task-notes', name);
    const note = await json(file, limits.recordBytes);
    const content = record(note?.content);
    if (!note) { invalidNotes++; continue; }
    if (note.version !== 1 || typeof note.projectId !== 'string' || (ledgerValid && note.projectId !== ledger.projectId)
      || typeof note.taskId !== 'string' || !note.taskId.trim() || typeof note.requestId !== 'string' || !note.requestId.trim()
      || !['task-local', 'proposal'].includes(text(note.route) ?? '') || !content || typeof content.title !== 'string' || typeof content.body !== 'string'
      || (note.memoryId !== undefined && typeof note.memoryId !== 'string')) {
      invalidNotes++; issue(file, 'Invalid or foreign task-note receipt'); continue;
    }
    if (note.route === 'task-local') taskLocalNotes++;
    else proposalNotes++;
  }
  const frequency = new Map<string, { id: string; title: string; taskIds: Set<string>; packets: number }>();
  for (const packet of packets) for (const item of packet.items) {
    const value = frequency.get(item.id) ?? { ...item, taskIds: new Set<string>(), packets: 0 };
    value.taskIds.add(packet.taskId); value.packets++; frequency.set(item.id, value);
  }
  const recent = packets.sort((a, b) => b.at - a.at).slice(0, 50);
  const bytes = recent.map((packet) => packet.bytes).sort((a, b) => a - b);
  const cohorts = (['unknown', 'prepared-empty-only', 'prepared-nonempty-only', 'mixed-prepared-contexts'] as const).map((exposure) => {
    const members = tasks.filter((task) => task.exposure === exposure);
    const validations: Record<string, number> = {};
    for (const task of members) { const status = task.validation.status ?? 'unknown'; validations[status] = (validations[status] ?? 0) + 1; }
    return { exposure, tasks: members.length, modelReportedValidationStatuses: validations };
  });
  return {
    version: 1, projectPath: root, projectId: ledgerValid ? ledger.projectId as string : null,
    benefitNotEstablished: true,
    interpretation: [
      'Context receipts prove preparation, not worker use or a memory-enabled setting.',
      'Missing receipts mean unknown exposure. Only an existing empty packet proves no context was prepared for that packet.',
      'Task validation and review statuses are model-reported; phase errors and review rounds are recorded run metadata.',
      'Receipts are not linked to the current run generation. Different tasks, phases and retries are not comparable on/off controls.',
      'These descriptive counts do not measure avoided mistakes, corrective turns or causal productivity benefit.',
    ],
    ledger: { available: ledgerValid, active: ledgerValid ? entries.filter((entry) => entry.status === 'active').length : null,
      pending: ledgerValid ? entries.filter((entry) => entry.status === 'proposed').length : null,
      conflicts: ledgerValid ? entries.filter((entry) => entry.status === 'proposed' && entry.reviewReason === 'conflict').length : null },
    capture: { jobsRead: captureJobsRead, candidates: candidateCount, taskLocalCandidates: ledgerValid ? taskLocalCandidates : null, definition: 'Task-local means no matching body/task in the current ledger or its revision history; it does not judge usefulness. An unavailable ledger makes this count unknown.' },
    taskNotes: { recordsRead: Math.min(noteFiles.length, limits.taskNotes), taskLocal: taskLocalNotes, proposals: proposalNotes, invalid: invalidNotes,
      definition: 'Worker-note journal routes, separate from automatic capture. A proposal route records intended publication, not proof that a ledger entry exists or was accepted.' },
    preparedContexts: { packets: packets.length, cohorts,
      mostFrequentlySupplied: [...frequency.values()].map(({ id, title, taskIds, packets: count }) => ({ id, title, distinctTasks: taskIds.size, packets: count })).sort((a, b) => b.distinctTasks - a.distinctTasks || b.packets - a.packets || a.id.localeCompare(b.id)).slice(0, 10),
      recentPromptBytes: { packets: bytes.length, total: bytes.reduce((sum, value) => sum + value, 0), median: bytes.length ? (bytes[Math.floor((bytes.length - 1) / 2)] + bytes[Math.floor(bytes.length / 2)]) / 2 : null, max: bytes.length ? bytes.at(-1)! : null } },
    tasks, bounds: { limits, selection: 'Task directory names descending; newest receipt filenames per task, then recent packet timestamps.',
      taskDirectoriesOmitted: Math.max(0, taskNames.length - limits.tasks), packetFilesOmitted, captureFilesOmitted: Math.max(0, captureFiles.length - limits.captureJobs),
      taskNoteFilesOmitted: Math.max(0, noteFiles.length - limits.taskNotes) },
    issueCount, issues,
  };
}
