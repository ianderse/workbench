import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Project, Task } from '../../../shared/types';
import { getSpecsDir } from '../../../shared/constants';
import { getCompengDir } from '../paths';
import { boundCaptureInput, captureTaskMemory, MEMORY_CAPTURE_INPUT_BYTES, MEMORY_EXTRACTION_VERSION, normalizeCapturedMemories, verifyMemoryCitation } from '../automatic-capture';
import { listProjectMemories, mutateProjectMemory } from '../project-memory';
vi.mock('../../claude-code/run-text', () => ({ runClaudeText: vi.fn(() => { throw new Error('Unexpected live model call'); }) }));
vi.mock('../../agent-backend/settings', () => ({ getAgentBackendSettings: () => ({ kind: 'omp' }) }));
// Use a real temporary repository while avoiding discovery of the user's runtime/tool settings.
vi.mock('../../utils/git-exec', () => ({ git: (args: string[], options: { cwd: string }) => promisify(execFile)('git', args, { cwd: options.cwd }) }));

let root: string;
let project: Project;
let task: Task;
let infoFile: string;
let sha: string;
const quote = 'Use atomic publication because interrupted writes must preserve the previous memory ledger.';
const candidate = { kind: 'decision' as const, title: 'Atomic memory publication', body: quote, evidence: 'Recorded rationale in the committed design document.', file: 'docs/decisions.md', quote, conflictsWith: [] };
const command = (args: string[]) => promisify(execFile)('git', args, { cwd: root });
const extract = vi.fn(async () => ({ memories: [candidate] }));
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wb-memory-capture-'));
  await command(['init', '-b', 'main']);
  await command(['config', 'user.email', 'fixture@example.test']);
  await command(['config', 'user.name', 'Memory fixture']);
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  await command(['add', '.']); await command(['commit', '-m', 'Initial fixture']);
  await command(['checkout', '-b', 'task-memory']);
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs/decisions.md'), quote + '\n');
  await command(['add', '.']); await command(['commit', '-m', 'Document rationale']);
  sha = (await command(['rev-parse', 'HEAD'])).stdout.trim();
  project = { id: 'memory-fixture', path: root, autoBuildPath: '.workbench', settings: { selfImprove: true, mainBranch: 'main' } } as Project;
  task = { id: '001-memory', specId: '001-memory', projectId: project.id, title: 'Preserve memory ledger on interruption', description: 'Investigate durable publication', status: 'human_review', reviewReason: 'completed' } as Task;
  await mkdir(path.join(root, '.workbench'), { recursive: true });
  await writeFile(path.join(root, '.workbench/settings.json'), JSON.stringify({ selfImprove: true }));
  infoFile = path.join(root, getSpecsDir(project.autoBuildPath), task.specId, 'claude_run.json');
  await mkdir(path.dirname(infoFile), { recursive: true });
  await writeFile(infoFile, JSON.stringify({ version: 1, sessionId: 'fixture', phases: [{ name: 'implement', startedAt: '2026-10-27T12:00:00Z', endedAt: '2026-10-27T12:01:00Z' }], summary: 'Documented why atomic publication is required.', worktreePath: root }));
  extract.mockClear();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const entries = () => listProjectMemories(getCompengDir(root), project.id);
const capture = () => captureTaskMemory(project, task, { extract });
const merge = async () => { await command(['checkout', 'main']); await command(['merge', '--ff-only', 'task-memory']); };
const journal = async () => {
  const dir = path.join(getCompengDir(root), 'records/captures');
  const files = await readdir(dir);
  return JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'));
};

it('captures once, waits for merge, then retains the checked quote without another extraction', async () => {
  await capture();
  expect(await entries()).toEqual([]);
  expect(await journal()).toMatchObject({ status: 'complete', candidates: [candidate] });
  await merge();
  await capture(); await capture();
  expect(extract).toHaveBeenCalledTimes(1);
  expect(await entries()).toHaveLength(1);
  expect((await entries())[0]).toMatchObject({ status: 'active', verification: 'source-backed', source: { commit: sha, file: 'docs/decisions.md', quote } });
});

it('refuses changed, fabricated, non-document and unmerged citations', async () => {
  expect(await verifyMemoryCitation(root, sha, 'main', { body: quote, source: candidate })).toBeUndefined();
  await command(['checkout', 'main']); await command(['merge', '--ff-only', 'task-memory']);
  expect(await verifyMemoryCitation(root, sha, 'main', { body: quote + ' invented', source: candidate })).toBeUndefined();
  expect(await verifyMemoryCitation(root, sha, 'main', { body: quote, source: { ...candidate, file: '../outside.md' } })).toBeUndefined();
  await writeFile(path.join(root, 'docs/decisions.md'), 'Superseded rationale.\n');
  await command(['add', '.']); await command(['commit', '-m', 'Change the decision']);
  expect(await verifyMemoryCitation(root, sha, 'main', { body: quote, source: candidate })).toBeUndefined();
});

it('keeps failed-run claims task-local even when their quote has merged', async () => {
  const info = JSON.parse(await readFile(infoFile, 'utf8')); info.phases[0].isError = true;
  await writeFile(infoFile, JSON.stringify(info));
  await command(['checkout', 'main']); await command(['merge', '--ff-only', 'task-memory']);
  await capture();
  expect(await entries()).toEqual([]);
  expect(await journal()).toMatchObject({ status: 'complete', candidates: [candidate] });
});

it('never captures a stale run or rediscovers an explicitly removed claim', async () => {
  await captureTaskMemory(project, task, { extract: async () => {
    const info = JSON.parse(await readFile(infoFile, 'utf8')); info.sessionId = 'new-run'; await writeFile(infoFile, JSON.stringify(info));
    return { memories: [candidate] };
  } });
  expect(await entries()).toEqual([]);
  await merge();
  await capture();
  const entry = (await entries())[0];
  await mutateProjectMemory(getCompengDir(root), project.id, { action: 'delete', id: entry.id, expectedRevision: entry.revision });
  const info = JSON.parse(await readFile(infoFile, 'utf8')); info.sessionId = 'third-run'; await writeFile(infoFile, JSON.stringify(info));
  await capture();
  expect(await entries()).toHaveLength(1);
  expect((await entries())[0].status).toBe('deleted');
});

it('persists extraction attempts and stops after three failures', async () => {
  const fail = vi.fn(async () => { throw new Error('Extraction interrupted'); });
  for (let i = 0; i < 3; i++) await expect(captureTaskMemory(project, task, { extract: fail })).rejects.toThrow('interrupted');
  expect(await captureTaskMemory(project, task, { extract: fail })).toBe(true);
  expect(fail).toHaveBeenCalledTimes(3);
  const dir = path.join(getCompengDir(root), 'records/captures');
  const files = await readdir(dir);
  expect(JSON.parse(await readFile(path.join(dir, files[0]), 'utf8')).attempts).toBe(3);
  expect(await entries()).toEqual([]);
});

it('records context overflows as terminal and does not retry on repeated completion or restart', async () => {
  const overflow = vi.fn(async () => { throw new Error('400 Prompt is too long: 72219 tokens > 40960 maximum context length (context_length_exceeded)'); });
  expect(await captureTaskMemory(project, task, { extract: overflow })).toBe(true);
  await captureTaskMemory(project, task, { extract: overflow });
  const dir = path.join(getCompengDir(root), 'records/captures');
  const jobFile = path.join(dir, (await readdir(dir))[0]);
  const job = JSON.parse(await readFile(jobFile, 'utf8'));
  expect(job).toMatchObject({ status: 'failed', attempts: 1, extractionVersion: MEMORY_EXTRACTION_VERSION, error: expect.stringContaining('context_length_exceeded') });
  expect(overflow).toHaveBeenCalledTimes(1);
  expect(await entries()).toEqual([]);
  // A journal exhausted by the old setup is eligible once the extraction policy changes.
  delete job.extractionVersion; job.status = 'extracting'; job.attempts = 3;
  await writeFile(jobFile, JSON.stringify(job));
  const fixed = vi.fn(async () => ({ memories: [] }));
  await captureTaskMemory(project, task, { extract: fixed });
  expect(fixed).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(jobFile, 'utf8'))).toMatchObject({ status: 'complete', attempts: 1, extractionVersion: MEMORY_EXTRACTION_VERSION });
});

it('bounds actual serialized capture input including Unicode and JSON escaping', () => {
  const raw = { task: 'Task', request: '\u0000'.repeat(30_000), outcome: '🧠'.repeat(30_000), reportedValidation: { summary: 'x'.repeat(50_000) },
    sources: Array.from({ length: 5 }, (_, i) => ({ file: `docs/${i}.md`, text: 'source'.repeat(5000) })), active: Array.from({ length: 30 }, (_, i) => ({ id: String(i), title: 'Memory', body: 'recalled'.repeat(5000) })) };
  const bounded = boundCaptureInput(raw);
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MEMORY_CAPTURE_INPUT_BYTES);
  expect(bounded.task).toBe(raw.task);
  expect(raw.active).toHaveLength(30);
});

it('bounds extraction and rejects fabricated conflict identifiers', () => {
  expect(normalizeCapturedMemories({ memories: [candidate, candidate, candidate] }, new Set())).toHaveLength(1);
  expect(normalizeCapturedMemories({ memories: [candidate, { ...candidate, title: 'Different rationale' }, { ...candidate, title: 'Third rationale' }] }, new Set())).toHaveLength(1);
  expect(() => normalizeCapturedMemories({ memories: [{ ...candidate, conflictsWith: ['invented'] }] }, new Set())).toThrow('unknown conflict');
  expect(normalizeCapturedMemories({ memories: [{ ...candidate, body: 'api_key=abcdefgh1234567890' }] }, new Set())).toEqual([]);
});

it('rejects task recaps and generic lesson prose instead of making them review work', () => {
  const bodies = [
    "Corrected the script and recorded JSON's throttled load note to explicitly describe 4x CPU slowdown and Slow 4G network emulation via CDP. The unthrottled note and audit behavior remain unchanged.",
    'The lesson highlights the importance of explicitly documenting network emulation settings to ensure audit accuracy and avoid misleading claims about network latency.',
    'It is important to document configuration accurately.',
  ];
  for (const body of bodies) expect(normalizeCapturedMemories({ memories: [{ ...candidate, body }] }, new Set())).toEqual([]);
  const body = 'When comparing qa:audit profiles, check the CDP CPU and network settings separately; CPU slowdown alone does not establish network latency.';
  expect(normalizeCapturedMemories({ memories: [{ ...candidate, body }] }, new Set())[0].body).toBe(body);
});

it('rejects implementation trivia under every category and requires real procedure steps', () => {
  const body = 'The PRNG uses the sfc32 generator with four state words; mixing via add/xor/shift plus counter increment. Chosen for its small size, speed, and passing basic statistical tests.';
  for (const kind of ['decision', 'lesson', 'procedure', 'preference']) {
    expect(normalizeCapturedMemories({ memories: [{ ...candidate, kind, title: 'PRNG Algorithm Details', body }] }, new Set())).toEqual([]);
  }
  const guidance = 'When changing campaign randomness, preserve the seeded sequence because recorded replays depend on the same random outcomes.';
  expect(normalizeCapturedMemories({ memories: [{ ...candidate, body: guidance }] }, new Set())).toHaveLength(1);
  expect(normalizeCapturedMemories({ memories: [{ ...candidate, kind: 'procedure', body: guidance }] }, new Set())).toEqual([]);
  const steps = guidance + '\n1. Run the seeded replay fixture.\n2. Compare the final state with its recorded baseline.';
  expect(normalizeCapturedMemories({ memories: [{ ...candidate, kind: 'procedure', body: steps }] }, new Set())).toHaveLength(1);
});

it('ignores copied active memories even when extraction calls them conflicts', () => {
  expect(normalizeCapturedMemories({ memories: [{ ...candidate, conflictsWith: ['existing'] }] }, new Set(['existing']), [candidate])).toEqual([]);
  expect(normalizeCapturedMemories({ memories: [{ ...candidate, kind: 'lesson', conflictsWith: ['existing'] }] }, new Set(['existing']), [candidate])).toEqual([]);
  expect(normalizeCapturedMemories({ memories: [candidate, { ...candidate, kind: 'lesson' }] }, new Set())).toHaveLength(1);
});

it('does not resurrect a dismissed claim by changing its category or title', async () => {
  await merge();
  await capture();
  const entry = (await entries())[0];
  await mutateProjectMemory(getCompengDir(root), project.id, { action: 'delete', id: entry.id, expectedRevision: entry.revision });
  const info = JSON.parse(await readFile(infoFile, 'utf8')); info.sessionId = 'later-run';
  await writeFile(infoFile, JSON.stringify(info));
  await captureTaskMemory(project, task, { extract: async () => ({ memories: [{ ...candidate, kind: 'lesson', title: 'A renamed claim', body: candidate.body.replaceAll(' ', '  ') }] }) });
  expect(await entries()).toHaveLength(1);
  expect((await entries())[0].status).toBe('deleted');
});

it('applies the quality gate to persisted extraction jobs without calling the model again', async () => {
  const empty = vi.fn(async () => ({ memories: [] }));
  await captureTaskMemory(project, task, { extract: empty });
  const jobs = path.join(getCompengDir(root), 'records/captures');
  const file = path.join(jobs, (await readdir(jobs))[0]);
  const job = JSON.parse(await readFile(file, 'utf8'));
  job.status = 'ready';
  job.candidates = [{ ...candidate, title: 'PRNG Algorithm Details', kind: 'procedure', body: 'The PRNG uses sfc32 with four state words.' }];
  await writeFile(file, JSON.stringify(job));
  await captureTaskMemory(project, task, { extract: empty });
  expect(empty).toHaveBeenCalledTimes(1);
  expect(await entries()).toEqual([]);
  expect(JSON.parse(await readFile(file, 'utf8')).status).toBe('complete');
});

it('does not create duplicates when another task rediscovers an accepted claim', async () => {
  await command(['checkout', 'main']); await command(['merge', '--ff-only', 'task-memory']);
  await capture();
  const first = (await entries())[0];
  const otherTask = { ...task, id: '002-later', specId: '002-later' };
  const otherInfo = path.join(root, getSpecsDir(project.autoBuildPath), otherTask.specId, 'claude_run.json');
  await mkdir(path.dirname(otherInfo), { recursive: true });
  await writeFile(otherInfo, await readFile(infoFile));
  await captureTaskMemory(project, otherTask, { extract });
  expect(await entries()).toEqual([first]);
});

it('normally records an empty extraction without creating a memory or repeating the model call', async () => {
  const empty = vi.fn(async () => ({ memories: [] }));
  await captureTaskMemory(project, task, { extract: empty });
  await captureTaskMemory(project, task, { extract: empty });
  expect(await entries()).toEqual([]);
  expect(await journal()).toMatchObject({ status: 'complete', candidates: [] });
  expect(empty).toHaveBeenCalledTimes(1);
});

it.each(['decision', 'procedure', 'preference'] as const)('keeps an unsupported %s in the task journal instead of the review inbox', async (kind) => {
  const body = 'When publishing memory, preserve the old ledger until the replacement is durable because interruption must not destroy accepted guidance.'
    + (kind === 'procedure' ? '\n1. Sync the temporary file.\n2. Rename it over the ledger.' : '');
  const localCandidate = { kind, title: 'Durable memory publication', body, evidence: 'Task report only; no verified documentation citation.', conflictsWith: [] };
  const localExtract = vi.fn(async () => ({ memories: [localCandidate] }));
  await merge();
  await captureTaskMemory(project, task, { extract: localExtract });
  await captureTaskMemory(project, task, { extract: localExtract });
  expect(await entries()).toEqual([]);
  expect(await journal()).toMatchObject({ status: 'complete', candidates: [localCandidate] });
  expect(localExtract).toHaveBeenCalledTimes(1);
});

it.each(['explicit', 'same-title'] as const)('retains a real active conflict (%s) for a decision without accepting it', async (mode) => {
  const old = await mutateProjectMemory(getCompengDir(root), project.id, {
    action: 'propose', requestId: 'manual:old', content: {
      kind: 'decision', title: candidate.title, body: 'Use direct writes for the ledger because a single process owns it.',
      source: { type: 'user', reference: 'standing decision', evidence: 'Explicit fixture instruction.' },
    },
  });
  await mutateProjectMemory(getCompengDir(root), project.id, { action: 'accept', id: old.id, expectedRevision: old.revision });
  const conflicting = { ...candidate, title: mode === 'same-title' ? candidate.title : 'Preserve concurrent ledger writes', conflictsWith: mode === 'explicit' ? [old.id] : [] };
  const conflictingExtract = vi.fn(async () => ({ memories: [conflicting] }));
  await captureTaskMemory(project, task, { extract: conflictingExtract });
  await captureTaskMemory(project, task, { extract: conflictingExtract });
  const all = await entries();
  expect(all).toHaveLength(2);
  expect(all.find((entry) => entry.id === old.id)).toMatchObject({ status: 'active', verification: 'user-confirmed' });
  expect(all.find((entry) => entry.id !== old.id)).toMatchObject({ status: 'proposed', reviewReason: 'conflict', conflictsWith: [old.id], verification: 'unverified' });
  expect(conflictingExtract).toHaveBeenCalledTimes(1);
});

it('does not create review work when the cited conflict is no longer active', async () => {
  const old = await mutateProjectMemory(getCompengDir(root), project.id, {
    action: 'propose', requestId: 'manual:old', content: {
      kind: 'decision', title: 'Old ledger policy', body: 'Use direct writes for the ledger because a single process owns it.',
      source: { type: 'user', reference: 'standing decision', evidence: 'Explicit fixture instruction.' },
    },
  });
  const active = await mutateProjectMemory(getCompengDir(root), project.id, { action: 'accept', id: old.id, expectedRevision: old.revision });
  await captureTaskMemory(project, task, { extract: async () => {
    await mutateProjectMemory(getCompengDir(root), project.id, { action: 'obsolete', id: old.id, expectedRevision: active.revision });
    return { memories: [{ ...candidate, conflictsWith: [old.id] }] };
  } });
  expect(await entries()).toHaveLength(1);
  expect((await entries())[0]).toMatchObject({ id: old.id, status: 'obsolete' });
  expect(await journal()).toMatchObject({ status: 'complete', candidates: [{ ...candidate, conflictsWith: [old.id] }] });
});
