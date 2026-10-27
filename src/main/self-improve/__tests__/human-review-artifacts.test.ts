import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Project, Task } from '../../../shared/types';
import { getHumanReviewPacket, reviewArtifactPath } from '../human-review-artifacts';
let root: string, worktree: string;
let project: Project, task: Task;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wb-review-materials-'));
  project = { id: 'p', path: root } as Project;
  task = { id: '085-review', specId: '085-review', projectId: 'p', claudeRun: { reviewVerdict: { failure: { openFindings: [{ file: 'docs/report.md' }] } } } } as Task;
  worktree = path.join(root, '.workbench/worktrees/tasks', task.specId);
  await mkdir(path.join(worktree, 'docs/review-gallery'), { recursive: true });
  await mkdir(path.join(worktree, 'art/source/portraits'), { recursive: true });
  await writeFile(path.join(worktree, 'docs/protocol.md'), 'Actual protocol in the task branch');
  await writeFile(path.join(worktree, 'docs/review-gallery/manifest.json'), '{}');
  await writeFile(path.join(worktree, 'art/source/portraits/one.svg'), '<svg/>');
  await writeFile(path.join(worktree, 'docs/report.md'), '# Review\n[Study protocol](protocol.md)\n[Gallery](review-gallery/manifest.json)\n[Art masters](../art/source/)\n\n## 6. Candid limitations\n- Portraits are silhouettes, not painted portraits.\n\n## 7. Other content\nNot a limitation.');
  await mkdir(path.join(root, 'docs')); await writeFile(path.join(root, 'docs/report.md'), 'OLDER_CHECKOUT_DO_NOT_USE');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('resolves the task branch report, its protocol and art, and reports missing generation honestly', async () => {
  const packet = await getHumanReviewPacket(project, task);
  expect(packet).toMatchObject({ root: await realpath(worktree), location: 'worktree' });
  expect(packet.artifacts).toContainEqual(expect.objectContaining({ path: 'docs/protocol.md', kind: 'protocol', available: true }));
  expect(packet.artifacts).toContainEqual(expect.objectContaining({ path: 'art/source', kind: 'asset', directory: true, imageCount: 1 }));
  expect(packet.artifacts).toContainEqual(expect.objectContaining({ path: 'art/source/generated', available: false }));
  expect(packet.limitations).toContain('Portraits are silhouettes');
  expect(packet.limitations).not.toContain('Other content');
  expect(JSON.stringify(packet)).not.toContain('OLDER_CHECKOUT');
});

it('rejects traversal, external URLs and symlink escapes while preserving missing-file information', async () => {
  const outside = path.join(root, 'outside.md'); await writeFile(outside, 'PRIVATE_OUTSIDE_CONTENT');
  await symlink(outside, path.join(worktree, 'docs/linked.md'));
  expect(await reviewArtifactPath(worktree, '../outside.md')).toBeUndefined();
  expect(await reviewArtifactPath(worktree, 'https://example.test/file.md')).toBeUndefined();
  expect(await reviewArtifactPath(worktree, 'docs/linked.md')).toBeUndefined();
  await writeFile(path.join(worktree, 'docs/report.md'), '[Linked doc](linked.md)\n[Escape](../../../../../../outside.md)');
  const packet = await getHumanReviewPacket(project, task);
  expect(packet.artifacts).toContainEqual(expect.objectContaining({ path: 'docs/linked.md', available: false }));
  expect(JSON.stringify(packet)).not.toContain('PRIVATE_OUTSIDE_CONTENT');
});

it('uses the project checkout only when the task has no worktree and counts actual generated files', async () => {
  await mkdir(path.join(worktree, 'art/source/generated'));
  await writeFile(path.join(worktree, 'art/source/generated/portrait.png'), 'synthetic image-file counting fixture');
  expect((await getHumanReviewPacket(project, task)).artifacts).toContainEqual(expect.objectContaining({ path: 'art/source/generated', available: true, imageCount: 1 }));
  await rm(worktree, { recursive: true });
  const packet = await getHumanReviewPacket(project, task);
  expect(packet.location).toBe('project');
  expect(packet.artifacts[0]).toMatchObject({ path: 'docs/report.md', available: true });
});

it('keeps a late gallery folder reachable in a long report with many earlier links', async () => {
  await writeFile(path.join(worktree, 'docs/report.md'), Array.from({ length: 60 }, (_, i) => `[Validation ${i}](validation-${i}.md)`).join('\n') + '\n[Matched gallery](review-gallery/manifest.json)');
  const packet = await getHumanReviewPacket(project, task);
  expect(packet.artifacts).toContainEqual(expect.objectContaining({ path: 'docs/review-gallery', kind: 'gallery', available: true, directory: true }));
  expect(packet.artifacts.length).toBeLessThanOrEqual(16);
});
