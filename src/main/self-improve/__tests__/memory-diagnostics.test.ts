import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { readProjectMemoryDiagnostics } from '../memory-diagnostics';

let root: string;
const write = async (file: string, data: unknown) => {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(data));
};
const ledger = (entries: unknown[] = []) => write('.workbench/compeng/records/project-memory.json', { version: 1, projectId: 'project', entries });
const packet = (taskId: string, index: number, ids: string[], prompt = ids.length ? 'bounded memory context' : '') => write(`.workbench/tasks/${taskId}/memory-context/${index}.json`, {
  version: 1, projectId: 'project', taskId, phase: 'implement', at: `2026-10-30T12:${String(index).padStart(2, '0')}:00.000Z`,
  prompt, items: ids.map((id) => ({ id, title: `Memory ${id}`, body: 'Private memory body must not be printed by diagnostics.' })),
});
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'wb-memory-diagnostics-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('distinguishes missing receipts from explicit empty and nonempty prepared packets', async () => {
  await ledger();
  await write('.workbench/tasks/001-missing/claude_run.json', { version: 1, phases: [], validation: { status: 'passed' }, reviewVerdict: { status: 'passed' } });
  await packet('002-empty', 1, []);
  await packet('003-nonempty', 2, ['a']);
  await packet('004-mixed', 3, []);
  await packet('004-mixed', 4, ['a']);
  const result = await readProjectMemoryDiagnostics({ projectPath: root });
  expect(result.tasks.map((task) => [task.taskId, task.exposure])).toEqual([
    ['004-mixed', 'mixed-prepared-contexts'], ['003-nonempty', 'prepared-nonempty-only'], ['002-empty', 'prepared-empty-only'], ['001-missing', 'unknown'],
  ]);
  const missing = result.tasks.find((task) => task.taskId === '001-missing')!;
  expect(missing).toMatchObject({ validation: { status: 'passed', evidence: 'model-reported' }, review: { status: 'passed', evidence: 'model-reported' }, outcomeAttribution: 'not-linked-to-context-receipts' });
  expect(result.benefitNotEstablished).toBe(true);
  expect(result.interpretation.join(' ')).toContain('not comparable on/off controls');
});

it('counts supplied memories by distinct tasks and reports bounded prompt bytes without their bodies', async () => {
  await ledger();
  await packet('001-task', 1, ['a', 'b'], '🧠');
  await packet('001-task', 2, ['a'], 'second');
  await packet('001-task', 3, ['a'], 'third');
  await packet('002-task', 4, ['b'], 'fourth');
  const result = await readProjectMemoryDiagnostics({ projectPath: root });
  expect(result.preparedContexts.mostFrequentlySupplied).toEqual([
    { id: 'b', title: 'Memory b', distinctTasks: 2, packets: 2 }, { id: 'a', title: 'Memory a', distinctTasks: 1, packets: 3 },
  ]);
  expect(result.preparedContexts.recentPromptBytes).toEqual({ packets: 4, total: 21, median: 5.5, max: 6 });
  expect(JSON.stringify(result)).not.toContain('Private memory body');
});

it('reports ledger and unpublished journal candidates without changing any records', async () => {
  const entry = { status: 'active', body: 'Current guidance', source: { type: 'task', reference: '001-task' }, history: [{ body: 'Older guidance', source: { type: 'task', reference: '001-task' } }] };
  await ledger([entry, { status: 'proposed', reviewReason: 'conflict' }, { status: 'proposed', reviewReason: 'unverified' }, { status: 'obsolete' }]);
  await write('.workbench/compeng/records/captures/a.json', { version: 1, taskId: '001-task', candidates: [{ body: ' Current   guidance ' }, { body: 'Older guidance' }, { body: 'Task-local finding' }] });
  const file = path.join(root, '.workbench/compeng/records/project-memory.json');
  const before = await readFile(file, 'utf8');
  const result = await readProjectMemoryDiagnostics({ projectPath: root });
  expect(result.ledger).toEqual({ available: true, active: 1, pending: 2, conflicts: 1 });
  expect(result.capture).toMatchObject({ jobsRead: 1, candidates: 3, taskLocalCandidates: 1 });
  expect(await readFile(file, 'utf8')).toBe(before);
});

it('bounds selection and excludes malformed, foreign, oversized and symlinked context files', async () => {
  await ledger();
  await packet('001-old', 1, ['old']);
  await packet('002-task', 1, ['a']);
  await write('.workbench/tasks/002-task/memory-context/2.json', { version: 1, projectId: 'foreign', taskId: '002-task', items: [], prompt: '', at: '2026-10-30T12:00:00Z' });
  await write('.workbench/tasks/002-task/memory-context/3.json', { version: 1, projectId: 'project', taskId: '002-task', items: [], prompt: 'inconsistent', at: '2026-10-30T12:00:00Z' });
  await write('.workbench/tasks/002-task/memory-context/4.json', { oversized: 'x'.repeat(65_000) });
  await symlink(path.join(root, '.workbench/tasks/001-old/memory-context/1.json'), path.join(root, '.workbench/tasks/002-task/memory-context/5.json'));
  await write('.workbench/worktrees/tasks/999-never-scan/memory-context/1.json', { ignored: true });
  const result = await readProjectMemoryDiagnostics({ projectPath: root, maxTasks: 1, maxPacketsPerTask: 4 });
  expect(result.tasks).toHaveLength(1);
  expect(result.tasks[0].taskId).toBe('002-task');
  expect(result.preparedContexts.packets).toBe(1);
  expect(result.bounds.taskDirectoriesOmitted).toBe(1);
  expect(result.issueCount).toBe(3);
  expect(result.bounds.packetFilesOmitted).toBe(0);
});

it('treats missing ledgers as unknown and rejects task paths outside the project', async () => {
  const result = await readProjectMemoryDiagnostics({ projectPath: root });
  expect(result.ledger).toEqual({ available: false, active: null, pending: null, conflicts: null });
  expect(result.capture.taskLocalCandidates).toBeNull();
  expect(result.benefitNotEstablished).toBe(true);
  await expect(readProjectMemoryDiagnostics({ projectPath: root, autoBuildPath: '../outside' })).rejects.toThrow('inside the project');
});

it('counts bounded worker-note routes separately from automatic capture and rejects invalid receipts', async () => {
  await ledger();
  const content = { kind: 'lesson', title: 'Task finding', body: 'Ordinary local finding.', source: { type: 'task', reference: '001-task', evidence: 'Task observation.' } };
  const note = { version: 1, projectId: 'project', taskId: '001-task', requestId: 'note', content };
  await write('.workbench/compeng/records/task-notes/1.json', { ...note, route: 'task-local' });
  // Publication can be interrupted after its route is pinned but before memoryId exists.
  await write('.workbench/compeng/records/task-notes/2.json', { ...note, route: 'proposal' });
  await write('.workbench/compeng/records/task-notes/3.json', { ...note, route: 'accepted' });
  await write('.workbench/compeng/records/task-notes/4.json', { ...note, projectId: 'foreign', route: 'task-local' });
  await writeFile(path.join(root, '.workbench/compeng/records/task-notes/5.json'), '{invalid json');
  const result = await readProjectMemoryDiagnostics({ projectPath: root });
  expect(result.taskNotes).toMatchObject({ recordsRead: 5, taskLocal: 1, proposals: 1, invalid: 3 });
  expect(result.capture).toMatchObject({ jobsRead: 0, candidates: 0, taskLocalCandidates: 0 });
  expect(result.ledger).toMatchObject({ active: 0, pending: 0 });
  expect(result.benefitNotEstablished).toBe(true);
  const bounded = await readProjectMemoryDiagnostics({ projectPath: root, maxTaskNotes: 3 });
  expect(bounded.taskNotes).toMatchObject({ recordsRead: 3, taskLocal: 0, proposals: 0, invalid: 3 });
  expect(bounded.bounds.taskNoteFilesOmitted).toBe(2);
});
