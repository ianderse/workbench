import { describe, expect, it } from 'vitest';
import path from 'path';
import type { Task } from '../../shared/types/task';
import type { HumanApprovalOverride, HumanWorkItem } from '../../shared/types/human-work';
import { formatSpecHumanDecisionContext, MAX_SPEC_HUMAN_DECISION_PROMPT_BYTES, resolveSpecHumanDecisionContext } from '../spec-human-decision-context';

const at = '2026-10-29T15:28:10.295Z';
const words = 'No human playtesting is needed at this point, finish and merge';
const override: HumanApprovalOverride = { scope: 'task-human-approval', approver: 'Ian', reason: words, at, revision: 3 };
const makeTask = (id: string, metadata: Task['metadata'] = {}, extra: Partial<Task> = {}) => ({
  id, specId: id, projectId: 'p', title: id, description: '', metadata, ...extra,
}) as Task;
const batch = (id = 'original', source = ['/project/docs/SPEC.md']) => ({ id, source, round: 1 });
const source = () => makeTask('189-playtest', { specBatch: batch(), userDescription: 'Execute §13.3 / §14 Gate F / §15.5 / §16 / §17 deliverable 9.', humanWork: {
  revision: 3, approvalOverride: { ...override }, items: [{ id: 'old-request', finding: { severity: 'major', description: 'Three testers and a long session required', requiresHuman: true },
    revision: 1, owner: '', status: 'open', response: '', evidence: '', at, createdAt: at, history: [] }],
} });
const target = () => makeTask('210-new-scope', { specBatch: batch('second', ['docs/SPEC.md', 'docs/REPORT.md']) });
const resolve = (current = target(), tasks = [source()]) => resolveSpecHumanDecisionContext(current, tasks, 'p', '/project', '/project/.workbench/tasks');
const receipt: HumanWorkItem = { id: 'response', revision: 2, owner: 'Ian', status: 'submitted', response: 'Defer only the returning session.',
  evidence: 'docs/decision.md', at, createdAt: at, history: [], finding: { severity: 'major', description: 'Returning session §13.3', requiresHuman: true } };

describe('related-spec human decisions', () => {
  it('matches absolute and relative sources across batches without inheriting an override', () => {
    const original = source();
    const context = resolve(target(), [original])!;
    expect(context.specs).toEqual(['docs/REPORT.md', 'docs/SPEC.md']);
    expect(context.records).toHaveLength(1);
    expect(context.records[0]).toMatchObject({ taskId: original.id, metadataPath: path.join('/project', '.workbench', 'tasks', '189-playtest', 'task_metadata.json'),
      matchedSpecs: ['docs/SPEC.md'], description: original.metadata!.userDescription, override, sourceFindings: [{ receiptId: 'old-request', finding: original.metadata!.humanWork!.items[0].finding }] });
    const prompt = formatSpecHumanDecisionContext(context);
    expect(prompt).toContain(words);
    expect(prompt).toContain('source task\'s actual requirements');
    expect(prompt).toContain('not an inherited task-wide override or overall spec acceptance');
    expect(prompt).toContain('"slice-wide" gate');
    expect(target().metadata!.humanWork).toBeUndefined();
    original.metadata!.humanWork!.approvalOverride!.reason = 'A later change';
    expect(context.records[0].override!.reason).toBe(words);
  });

  it('resolves legacy spec-review batch sources and split/follow-up lineage', () => {
    const review = makeTask('209-review', { specReview: { batchId: 'second', round: 1 } });
    expect(resolve(review, [target(), source()])!.records).toHaveLength(1);
    const child = makeTask('211-split', { splitFrom: review.id });
    expect(resolve(child, [review, target(), source()])!.records).toHaveLength(1);
    const followup = makeTask('212-followup', { followUpFrom: { taskId: '189-playtest', item: 'same requirement' } });
    expect(resolve(followup, [source()])!.records).toHaveLength(1);
  });

  it('excludes other projects/specs, the current task, and invalid or external source paths', () => {
    const otherProject = source(); otherProject.projectId = 'other';
    const otherSpec = source(); otherSpec.id = otherSpec.specId = '190-unrelated'; otherSpec.metadata!.specBatch!.source = ['docs/OTHER.md'];
    expect(resolve(target(), [otherProject, otherSpec])!.records).toEqual([]);
    expect(resolve(source(), [source()])!.records).toEqual([]);
    for (const spec of ['../outside.md', '/outside/SPEC.md', 'https://example.com/SPEC.md', 'docs/SPEC.ts', 'docs/SPEC.md\0']) {
      const invalid = source(); invalid.metadata!.specBatch!.source = [spec];
      expect(resolve(target(), [invalid])!.records).toEqual([]);
    }
    expect(resolve(makeTask('bad', { specBatch: batch('bad', ['../escape.md']) }), [])!.unresolved).not.toEqual([]);
    expect(resolve(makeTask('ordinary'), [])).toBeUndefined();
  });

  it('retains only actual valid overrides or complete named submitted responses', () => {
    const submitted = makeTask('200-response', { specBatch: batch(), humanWork: { revision: 2, items: [structuredClone(receipt)] } });
    expect(resolve(target(), [submitted])!.records[0].receipts).toEqual([receipt]);
    for (const changes of [{ status: 'open' }, { owner: '' }, { response: '' }, { evidence: '' }, { at: 'unknown' }, { revision: 0 }]) {
      submitted.metadata!.humanWork!.items = [{ ...receipt, ...changes } as HumanWorkItem];
      expect(resolve(target(), [submitted])!.records).toEqual([]);
    }
    const invalid = source(); invalid.metadata!.humanWork!.approvalOverride!.scope = 'project' as 'task-human-approval';
    expect(resolve(target(), [invalid])!.records).toEqual([]);
  });

  it('dates current requests separately from an older override without presenting them as its historical scope', () => {
    const original = source();
    const later = '2026-10-30T18:00:00Z';
    original.metadata!.userDescription += ' Later addition: run a new accessibility study.';
    original.metadata!.humanWork!.items.push({
      ...structuredClone(receipt), id: 'later-request', revision: 1, createdAt: later, at: later,
      owner: '', status: 'open', response: '', evidence: '',
      finding: { severity: 'major', description: 'New accessibility study added after the waiver', requiresHuman: true },
    });
    const context = resolve(target(), [original])!;
    expect(context.records[0].sourceFindings[1]).toEqual({
      receiptId: 'later-request', revision: 1, createdAt: later, at: later,
      finding: original.metadata!.humanWork!.items[1].finding,
    });
    expect(context.records[0].override!.at).toBe(at);
    const prompt = formatSpecHumanDecisionContext(context);
    expect(prompt).toContain('current scope evidence, not immutable snapshots of the scope at decision time');
    expect(prompt).toContain('Do not extend an older decision to later or newly added requirements');
    expect(prompt).toContain(later);
    expect(prompt).toContain(at);
    expect(target().metadata!.humanWork).toBeUndefined();
  });

  it('references oversized decisions and changes fingerprints without silently clipping scope', () => {
    const original = source(); original.metadata!.humanWork!.approvalOverride!.reason = words + '界'.repeat(12_000);
    const first = resolve(target(), [original])!;
    const prompt = formatSpecHumanDecisionContext(first, (value) => '/runtime' + value);
    expect(prompt).toContain('Full scope/decision text is referenced rather than truncated');
    expect(prompt).toContain(JSON.stringify('/runtime' + path.join('/project', '.workbench', 'tasks', '189-playtest', 'task_metadata.json')));
    expect(prompt).not.toContain('界');
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(MAX_SPEC_HUMAN_DECISION_PROMPT_BYTES);
    original.metadata!.humanWork!.approvalOverride!.reason += ' Keep this withheld.';
    const second = resolve(target(), [original])!;
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(formatSpecHumanDecisionContext(second)).not.toBe(prompt);
  });

  it('bounds record count without pretending that additional evidence does not exist', () => {
    const originals = Array.from({ length: 15 }, (_, i) => { const original = source(); original.id = original.specId = `source-${i}`; return original; });
    const context = resolve(target(), originals)!;
    expect(context.records).toHaveLength(12);
    expect(context.omittedRecords).toBe(3);
    expect(formatSpecHumanDecisionContext(context)).toContain('3 additional related records');
    originals[14].metadata!.humanWork!.approvalOverride!.reason = 'Different later decision';
    expect(resolve(target(), originals)!.fingerprint).not.toBe(context.fingerprint);
    originals[14].metadata!.humanWork!.approvalOverride!.at = '2026-10-30T12:00:00Z';
    expect(resolve(target(), originals)!.records[0].taskId).toBe('source-14');
  });

  it('marks unavailable/partial lookup and unresolved ancestry without asserting absent approval', () => {
    const review = makeTask('209-review', { specReview: { batchId: 'missing', round: 1 } });
    const prompt = formatSpecHumanDecisionContext(resolve(review, []));
    expect(prompt).toContain('sources could not be loaded');
    expect(prompt).toContain('not proof that no owner decision exists');
    const context = resolve(target(), [])!;
    expect(formatSpecHumanDecisionContext({ ...context, lookupUnavailable: true })).toContain('Related project-task lookup was unavailable');
    const deep = Array.from({ length: 14 }, (_, i) => makeTask(`deep-${i}`, { splitFrom: `deep-${i + 1}` }));
    expect(formatSpecHumanDecisionContext(resolve(deep[0], deep))).toContain('bounded lookup');
  });
});
