import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import type { ClaudeRunInfo } from '../../shared/types/claude-code';
import type { PhaseHandoffReceipt, SessionEpoch } from '../../shared/types/task-throughput';
import { git } from '../utils/git-exec';

export type { PhaseHandoffReceipt, SessionEpoch } from '../../shared/types/task-throughput';

interface PreservedFile { path: string; bytes: number; sha256: string }
interface WorktreeState {
  head: string;
  branch: string;
  base?: string;
  status: string;
  workingPatch: string;
  indexPatch: string;
  untracked: Array<{ path: string; kind: 'file' | 'symlink'; bytes: number; sha256: string }>;
  fingerprint: string;
}
interface HandoffManifest {
  version: 1;
  id: string;
  boundaryKey: string;
  createdAt: string;
  nextPhase: string;
  reason: string;
  priorSessionId?: string;
  worktreePath: string;
  git: Omit<WorktreeState, 'workingPatch' | 'indexPatch'>;
  files: PreservedFile[];
}
interface HandoffBrief {
  nextPhase: string;
  reason: string;
  branch: string;
  head: string;
  priorSessionId?: string;
  completedPhases: string[];
  observedChecks: Array<{ name: string; passed: boolean }>;
  openFindings: string[];
  taskMetadata: string;
  plan?: string;
  summary?: string;
}

export interface PreparePhaseHandoffOptions {
  specDir: string;
  worktreePath: string;
  runInfo: ClaudeRunInfo;
  nextPhase: string;
  reason: string;
  boundaryKey: string;
  baseRef?: string;
  pendingWork?: boolean;
  /** Additional closed transcripts or folders. Adjacent Claude session folders and OMP sessions are included automatically. */
  transcriptRoots?: string[];
  handoffText?: string;
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const handoffDir = (specDir: string, boundaryKey: string) => path.join(specDir, 'phase-handoffs', hash(boundaryKey));
const utf8Bytes = (value: string) => Buffer.byteLength(value, 'utf8');
const MAX_HANDOFF_PROMPT_BYTES = 8 * 1024;

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** File sync precedes rename. Directory sync is best effort only where the platform supports it. */
async function durableJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.rename(temporary, file);
    try {
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function fileHash(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}

function safeRelative(relative: string): void {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Unsafe handoff file reference');
}

async function captureWorktree(worktreePath: string, baseRef?: string): Promise<WorktreeState> {
  const options = { cwd: worktreePath, isolated: true, maxBuffer: 64 * 1024 * 1024 };
  const results = await Promise.all([
    git(['rev-parse', 'HEAD'], options),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], options),
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], options),
    git(['diff', '--binary', '--no-ext-diff', '--no-textconv'], options),
    git(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'], options),
    git(['ls-files', '--others', '--exclude-standard', '-z'], options),
    git(['ls-files', '--unmerged', '-z'], options),
    git(['rev-parse', '--git-path', 'MERGE_HEAD'], options),
    baseRef ? git(['rev-parse', '--verify', baseRef], options) : Promise.resolve(undefined),
  ]);
  const mergeHead = path.resolve(worktreePath, results[7].stdout.trim());
  if (results[6].stdout || await exists(mergeHead)) throw new Error('Finish the in-progress merge before continuing with fresh context');
  const untracked: WorktreeState['untracked'] = [];
  for (const relative of results[5].stdout.split('\0').filter(Boolean).sort()) {
    safeRelative(relative);
    const full = path.join(worktreePath, relative);
    const info = await fs.lstat(full);
    if (info.isSymbolicLink()) {
      const target = await fs.readlink(full);
      untracked.push({ path: relative, kind: 'symlink', bytes: utf8Bytes(target), sha256: hash(target) });
    } else if (info.isFile()) {
      untracked.push({ path: relative, kind: 'file', bytes: info.size, sha256: await fileHash(full) });
    } else throw new Error(`Cannot preserve non-file untracked path: ${relative}`);
  }
  const state = {
    head: results[0].stdout.trim(), branch: results[1].stdout.trim(),
    ...(results[8] ? { base: results[8].stdout.trim() } : {}),
    status: results[2].stdout, workingPatch: results[3].stdout, indexPatch: results[4].stdout, untracked,
  };
  return { ...state, fingerprint: hash(JSON.stringify(state)) };
}

/** Includes staged/unstaged content and untracked content, not just names or diff statistics. */
export async function fingerprintWorktree(worktreePath: string, baseRef?: string): Promise<string> {
  return (await captureWorktree(worktreePath, baseRef)).fingerprint;
}

async function preserveFile(source: string, directory: string, relative: string, files: PreservedFile[]): Promise<void> {
  safeRelative(relative);
  const before = await fs.lstat(source);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Session preservation requires a regular file: ${source}`);
  const target = path.join(directory, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  const [sourceHash, targetHash, after] = await Promise.all([fileHash(source), fileHash(target), fs.stat(source)]);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || sourceHash !== targetHash) throw new Error('A session changed while its preservation receipt was being prepared');
  // Flush the owned archive copy through a writable handle: Windows rejects fsync
  // on a read-only handle. Never open or change the source transcript for writing.
  const handle = await fs.open(target, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  files.push({ path: relative, bytes: after.size, sha256: targetHash });
}

async function preserveTree(source: string, directory: string, relative: string, files: PreservedFile[]): Promise<void> {
  const info = await fs.lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Session preservation does not follow symlinks: ${source}`);
  if (info.isFile()) return preserveFile(source, directory, relative, files);
  if (!info.isDirectory()) throw new Error(`Unsupported session artifact: ${source}`);
  for (const name of (await fs.readdir(source)).sort()) {
    if (name.endsWith('.lock') || name.endsWith('.lock.os')) continue;
    await preserveTree(path.join(source, name), directory, path.join(relative, name), files);
  }
}

async function preserveText(directory: string, relative: string, text: string, files: PreservedFile[]): Promise<void> {
  const full = path.join(directory, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const handle = await fs.open(full, 'wx');
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  files.push({ path: relative, bytes: utf8Bytes(text), sha256: hash(text) });
}

/** Only a verified receipt is reusable; an interrupted preparation is never mistaken for completion. */
export async function preparePhaseHandoff(options: PreparePhaseHandoffOptions): Promise<PhaseHandoffReceipt> {
  if (options.pendingWork || options.runInfo.subagents.some((agent) => agent.status === 'running')) throw new Error('Wait for pending tools, jobs and subagents before continuing with fresh context');
  if (!options.boundaryKey.trim()) throw new Error('A phase handoff needs a durable boundary key');
  const relativeSpec = path.relative(path.resolve(options.worktreePath), path.resolve(options.specDir));
  if (!relativeSpec || (!relativeSpec.startsWith(`..${path.sep}`) && relativeSpec !== '..' && !path.isAbsolute(relativeSpec))) {
    // Otherwise our own archive would enter the untracked inventory, recursively copying itself.
    try { await git(['check-ignore', '--quiet', '--', path.join(relativeSpec, 'phase-handoffs', '.preservation-probe')], { cwd: options.worktreePath, isolated: true }); }
    catch { throw new Error('Workbench handoff storage must be outside the worktree or gitignored'); }
  }
  const directory = handoffDir(options.specDir, options.boundaryKey);
  const receiptFile = path.join(directory, 'receipt.json');
  if (await exists(receiptFile)) {
    const prior = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as PhaseHandoffReceipt;
    if (prior.boundaryKey !== options.boundaryKey || prior.nextPhase !== options.nextPhase) throw new Error('Conflicting phase handoff boundary');
    await verifyPhaseHandoff(prior, { worktreePath: options.worktreePath, requireCurrentWorktree: true });
    return prior;
  }
  // Independent retries use separate staging folders. Nothing incomplete occupies the published path.
  const temporary = `${directory}.preparing-${randomUUID()}`;
  await fs.mkdir(temporary, { recursive: true });
  const state = await captureWorktree(options.worktreePath, options.baseRef);
  const files: PreservedFile[] = [];
  const id = hash(options.boundaryKey);
  const createdAt = new Date().toISOString();
  await preserveText(temporary, 'run-snapshot.json', JSON.stringify(options.runInfo, null, 2), files);
  await preserveText(temporary, 'working.patch', state.workingPatch, files);
  await preserveText(temporary, 'index.patch', state.indexPatch, files);
  for (const item of state.untracked) {
    if (item.kind === 'symlink') {
      // Preserve the link target as data, never recreate a potentially escaping link in the archive.
      await preserveText(temporary, path.join('untracked-links', hash(item.path)), JSON.stringify({ path: item.path, target: await fs.readlink(path.join(options.worktreePath, item.path)) }), files);
    } else await preserveFile(path.join(options.worktreePath, item.path), temporary, path.join('untracked', item.path), files);
  }
  for (const name of ['plan.md', 'task_metadata.json', 'resync_request.json']) {
    const source = path.join(options.specDir, name);
    if (await exists(source)) await preserveFile(source, temporary, name, files);
  }
  const roots = [path.join(options.specDir, 'omp-sessions'), ...(options.transcriptRoots ?? [])];
  // Claude keeps a session's child transcripts in <session-id>/ beside <session-id>.jsonl.
  // Preserve the complete companion tree when callers supply the parent transcript alone.
  for (const source of options.transcriptRoots ?? []) {
    if (source.endsWith('.jsonl')) {
      const companion = source.slice(0, -'.jsonl'.length);
      if (await exists(companion)) roots.push(companion);
    }
  }
  for (const [index, source] of [...new Set(roots)].entries()) {
    if (!await exists(source)) {
      if (index === 0) continue;
      throw new Error(`Session transcript is unavailable: ${source}`);
    }
    await preserveTree(source, temporary, path.join('sessions', String(index), path.basename(source)), files);
  }
  if (options.runInfo.sessionId && !files.some((file) => file.path.startsWith(`sessions${path.sep}`) && file.path.endsWith('.jsonl') && path.basename(file.path).includes(options.runInfo.sessionId!))) {
    throw new Error('The current raw session transcript was not preserved');
  }
  const brief: HandoffBrief = {
    nextPhase: options.nextPhase, reason: options.reason, branch: state.branch, head: state.head,
    ...(options.runInfo.sessionId ? { priorSessionId: options.runInfo.sessionId } : {}),
    completedPhases: options.runInfo.phases.filter((phase) => phase.endedAt && !phase.isError).map((phase) => phase.name),
    observedChecks: (options.runInfo.validation?.checks ?? []).map(({ name, passed }) => ({ name, passed })),
    openFindings: (options.runInfo.validation?.findings ?? []).filter((finding) => !finding.fixed).map((finding) => finding.description),
    taskMetadata: path.join(options.specDir, 'task_metadata.json'),
    ...(await exists(path.join(options.specDir, 'plan.md')) ? { plan: path.join(directory, 'plan.md') } : {}),
    ...(options.handoffText ?? options.runInfo.summary ? { summary: options.handoffText ?? options.runInfo.summary } : {}),
  };
  await preserveText(temporary, 'handoff.json', JSON.stringify(brief, null, 2), files);
  if (await fingerprintWorktree(options.worktreePath, options.baseRef) !== state.fingerprint) throw new Error('The worktree changed while preparing its phase handoff');
  const { workingPatch: _workingPatch, indexPatch: _indexPatch, ...gitState } = state;
  const manifest: HandoffManifest = {
    version: 1, id, boundaryKey: options.boundaryKey, createdAt, nextPhase: options.nextPhase, reason: options.reason,
    ...(options.runInfo.sessionId ? { priorSessionId: options.runInfo.sessionId } : {}),
    worktreePath: path.resolve(options.worktreePath), git: gitState, files,
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  const manifestHandle = await fs.open(path.join(temporary, 'manifest.json'), 'wx');
  try { await manifestHandle.writeFile(manifestText); await manifestHandle.sync(); }
  finally { await manifestHandle.close(); }
  const receipt: PhaseHandoffReceipt = {
    version: 1, id, boundaryKey: options.boundaryKey, path: directory, manifestPath: path.join(directory, 'manifest.json'),
    digest: hash(manifestText), createdAt, nextPhase: options.nextPhase, reason: options.reason,
    ...(options.runInfo.sessionId ? { priorSessionId: options.runInfo.sessionId } : {}), gitFingerprint: state.fingerprint,
  };
  await durableJson(path.join(temporary, 'receipt.json'), receipt);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  try { await fs.rename(temporary, directory); }
  catch (error) {
    if (!await exists(receiptFile)) throw error;
    const published = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as PhaseHandoffReceipt;
    await verifyPhaseHandoff(published, { worktreePath: options.worktreePath, requireCurrentWorktree: true });
    if (published.boundaryKey !== options.boundaryKey || published.nextPhase !== options.nextPhase) throw new Error('Conflicting phase handoff publication');
    return published;
  }
  await verifyPhaseHandoff(receipt, { worktreePath: options.worktreePath, requireCurrentWorktree: true });
  return receipt;
}

export async function verifyPhaseHandoff(receipt: PhaseHandoffReceipt, options: { worktreePath?: string; requireCurrentWorktree?: boolean } = {}): Promise<void> {
  if (receipt.version !== 1 || receipt.manifestPath !== path.join(receipt.path, 'manifest.json')) throw new Error('Invalid phase handoff receipt');
  const text = await fs.readFile(receipt.manifestPath, 'utf8');
  if (hash(text) !== receipt.digest) throw new Error('Phase handoff manifest checksum mismatch');
  const manifest = JSON.parse(text) as HandoffManifest;
  if (manifest.version !== 1 || manifest.id !== receipt.id || manifest.boundaryKey !== receipt.boundaryKey || manifest.git.fingerprint !== receipt.gitFingerprint
    || manifest.nextPhase !== receipt.nextPhase || manifest.reason !== receipt.reason || manifest.createdAt !== receipt.createdAt || manifest.priorSessionId !== receipt.priorSessionId) throw new Error('Phase handoff identity mismatch');
  for (const item of manifest.files) {
    safeRelative(item.path);
    const file = path.join(receipt.path, item.path);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== item.bytes || await fileHash(file) !== item.sha256) throw new Error(`Phase handoff artifact failed verification: ${item.path}`);
  }
  if (options.requireCurrentWorktree) {
    if (!options.worktreePath || path.resolve(options.worktreePath) !== manifest.worktreePath) throw new Error('Phase handoff belongs to another worktree');
    if ((await captureWorktree(options.worktreePath, manifest.git.base)).fingerprint !== manifest.git.fingerprint) throw new Error('Worktree changed after its phase handoff was prepared');
  }
}

export async function buildHandoffPrompt(receipt: PhaseHandoffReceipt): Promise<string> {
  await verifyPhaseHandoff(receipt);
  const brief = JSON.parse(await fs.readFile(path.join(receipt.path, 'handoff.json'), 'utf8')) as HandoffBrief;
  const header = `## Continue in fresh context\nThis is a continuation of the same task in the same worktree. Previous session: ${JSON.stringify(brief.priorSessionId ?? '(none)')}. Next phase: ${JSON.stringify(brief.nextPhase)}.\nVerified preservation receipt: ${JSON.stringify(path.join(receipt.path, 'receipt.json'))}\nFull handoff: ${JSON.stringify(path.join(receipt.path, 'handoff.json'))}\nBranch/HEAD at handoff: ${JSON.stringify(brief.branch)} / ${brief.head}\nInspect git status and git log before working. Keep the existing commits, dirty files and untracked files; do not reset, clean or repeat completed work. Original transcripts and prior run state are preserved. Read the saved plan and current named human decisions at ${JSON.stringify(brief.taskMetadata)} (read-only Workbench metadata). Recorded checks describe observations, not proof that the current tree still passes.\n${brief.plan ? `Saved plan: ${JSON.stringify(brief.plan)}\n` : ''}`;
  const context = JSON.stringify({ completedPhases: brief.completedPhases, observedChecks: brief.observedChecks, openFindings: brief.openFindings, summary: brief.summary }, null, 2);
  const result = `${header}\n${context}`;
  if (utf8Bytes(result) <= MAX_HANDOFF_PROMPT_BYTES) return result;
  const fallback = `${header}\nThe detailed handoff exceeds this prompt's budget and is omitted in full. Read the referenced handoff before deciding what remains; do not infer approval or success from this short index.`;
  if (utf8Bytes(fallback) <= MAX_HANDOFF_PROMPT_BYTES) return fallback;
  const minimal = `## Continue in fresh context\nRead the full verified handoff before continuing: ${JSON.stringify(path.join(receipt.path, 'handoff.json'))}\nManifest checksum: ${receipt.digest}\nContinue in the same worktree, preserving its commits, dirty files and untracked files. The full handoff carries the phase, plan, observed checks and current human-decision references. Do not infer approval or successful checks from this short reference, or modify Workbench metadata.`;
  if (utf8Bytes(minimal) > MAX_HANDOFF_PROMPT_BYTES) throw new Error('The phase handoff reference exceeds its prompt budget');
  return minimal;
}

const epochRanks = { prepared: 0, acknowledged: 1, running: 2 } as const;
function validEpoch(epoch: SessionEpoch): void {
  if (!epoch || !/^[A-Za-z0-9_-]{1,128}$/.test(epoch.id) || !Object.hasOwn(epochRanks, epoch.state) || !epoch.boundaryKey || epoch.handoff.boundaryKey !== epoch.boundaryKey) throw new Error('Invalid fresh-session epoch');
  if (epoch.sessionId !== undefined && !/^[A-Za-z0-9_-]{1,160}$/.test(epoch.sessionId)) throw new Error('Invalid acknowledged session identity');
  if (epoch.backend !== undefined && epoch.backend !== 'claude' && epoch.backend !== 'omp') throw new Error('Invalid fresh-session backend');
  if (epoch.runtime !== undefined && epoch.runtime !== 'native' && epoch.runtime !== 'wsl') throw new Error('Invalid fresh-session runtime');
  if (epoch.state !== 'prepared' && !epoch.sessionId) throw new Error('A fresh-session epoch must acknowledge its session before running');
  if (epoch.manualRequestIds !== undefined && (!Array.isArray(epoch.manualRequestIds) || epoch.manualRequestIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)))) throw new Error('Invalid consumed fresh-context request identities');
}

export async function loadSessionEpoch(specDir: string): Promise<SessionEpoch | undefined> {
  const file = path.join(specDir, 'session_epoch.json');
  if (!await exists(file)) return undefined;
  let epoch = JSON.parse(await fs.readFile(file, 'utf8')) as SessionEpoch;
  validEpoch(epoch);
  // A process can stop after the immutable transition was synced but before the current pointer.
  for (const state of ['acknowledged', 'running'] as const) {
    if (epochRanks[state] <= epochRanks[epoch.state]) continue;
    const artifact = path.join(specDir, 'session-epochs', epoch.id, `${state}.json`);
    if (!await exists(artifact)) continue;
    if (epochRanks[state] - epochRanks[epoch.state] !== 1) throw new Error('Fresh-session recovery is missing its acknowledged transition');
    const advanced = JSON.parse(await fs.readFile(artifact, 'utf8')) as SessionEpoch;
    validEpoch(advanced);
    if (advanced.id !== epoch.id || advanced.state !== state || advanced.boundaryKey !== epoch.boundaryKey || advanced.handoff.digest !== epoch.handoff.digest
      || advanced.priorSessionId !== epoch.priorSessionId || (epoch.sessionId && advanced.sessionId !== epoch.sessionId)
      || (epoch.backend && advanced.backend !== epoch.backend) || (epoch.runtime && advanced.runtime !== epoch.runtime)) throw new Error('Conflicting fresh-session recovery artifact');
    epoch = advanced;
    await durableJson(file, epoch);
  }
  return epoch;
}

const epochWrites = new Map<string, Promise<unknown>>();
/** The journal is critical: an error propagates before an OMP prompt may be submitted. */
export async function persistSessionEpoch(specDir: string, epoch: SessionEpoch): Promise<void> {
  const key = path.resolve(specDir);
  const previous = epochWrites.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => persistEpoch(specDir, epoch));
  epochWrites.set(key, next);
  try { await next; } finally { if (epochWrites.get(key) === next) epochWrites.delete(key); }
}

async function persistEpoch(specDir: string, epoch: SessionEpoch): Promise<void> {
  validEpoch(epoch);
  const previous = await loadSessionEpoch(specDir);
  if (previous?.id === epoch.id) {
    if (previous.boundaryKey !== epoch.boundaryKey || previous.handoff.digest !== epoch.handoff.digest || previous.priorSessionId !== epoch.priorSessionId
      || (previous.sessionId && previous.sessionId !== epoch.sessionId) || (previous.backend && previous.backend !== epoch.backend) || (previous.runtime && previous.runtime !== epoch.runtime)) throw new Error('Conflicting fresh-session epoch identity');
    const step = epochRanks[epoch.state] - epochRanks[previous.state];
    if (step < 0 || step > 1) throw new Error('Invalid fresh-session epoch transition');
  } else if (previous?.boundaryKey === epoch.boundaryKey) {
    throw new Error('This phase boundary already has a fresh-session epoch');
  } else if (previous && (previous.state !== 'running' || epoch.state !== 'prepared')) {
    throw new Error('A fresh-session transition is already pending');
  } else if (!previous && epoch.state !== 'prepared') throw new Error('Prepare the fresh-session epoch before acknowledging it');
  const lineage = path.join(specDir, 'session-epochs', epoch.id, `${epoch.state}.json`);
  if (!await exists(lineage)) await durableJson(lineage, epoch);
  else {
    const prior = JSON.parse(await fs.readFile(lineage, 'utf8')) as SessionEpoch;
    if (prior.sessionId !== epoch.sessionId || prior.handoff.digest !== epoch.handoff.digest || prior.boundaryKey !== epoch.boundaryKey) throw new Error('Conflicting preserved epoch transition');
  }
  await durableJson(path.join(specDir, 'session_epoch.json'), epoch);
}
