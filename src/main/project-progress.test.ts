import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Project, Task } from '../shared/types';
import { PROJECT_PROGRESS_MARKER, PROJECT_PROGRESS_MAX_BYTES, projectProgressPath, refreshProjectProgress, renderProjectProgress } from './project-progress';
vi.mock('./app-logger', () => ({ appLog: { warn: vi.fn() } }));
const exec = promisify(execFile);
const roots: string[] = [];
const task = (id: string, status: Task['status'] = 'in_progress') => ({ id, specId: id, title: `Task ${id}`, status, projectId: 'p', updatedAt: new Date('2026-10-28T12:00:00Z') }) as Task;
async function fixture(ignored = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-project-progress-'));
  roots.push(root);
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  await fs.writeFile(path.join(root, '.gitignore'), ignored ? '.workbench/\n' : 'node_modules/\n');
  await fs.writeFile(path.join(root, 'PROGRESS.md'), 'Authored root status, keep this exact.\n');
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'initial'], { cwd: root });
  return { root, project: { id: 'p', name: 'Example', path: root, settings: {} } as Project };
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('bounded project progress', () => {
  it('bounds huge histories and multilingual titles with honest omissions and no inferred acceptance', () => {
    const tasks = Array.from({ length: 500 }, (_, n) => ({ ...task(String(n)), title: '界'.repeat(5000) }));
    const text = renderProjectProgress({ name: 'Example' }, tasks);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PROJECT_PROGRESS_MAX_BYTES);
    expect(text).toContain('omitted');
    expect(text).toContain('revision unavailable');
    expect(text).toContain('tracked changes unavailable');
    expect(text).toContain('not instructions, approval, or proof of acceptance');
  });

  it('separates board Done and reported checks from actual integration receipts', () => {
    const done = task('done', 'done');
    const merged = { ...task('merged', 'human_review'), metadata: { autoMerge: { branch: 'integration', sha: 'abc123', at: '2026-10-28T10:00:00Z', pushed: false } } } as Task;
    const text = renderProjectProgress({ name: 'Example' }, [done, merged]);
    expect(text).toContain('Done is a board status (1 recorded)');
    expect(text).toContain('target="integration", revision="abc123", pushed=not established');
    expect(text).toContain('validation unavailable');
    expect(text).not.toContain('target="main"');
  });

  it('writes only ignored managed state, preserves authored root and leaves tracked/untracked work intact', async () => {
    const { root, project } = await fixture();
    await fs.writeFile(path.join(root, 'unfinished.txt'), 'untracked work');
    const before = (await exec('git', ['status', '--porcelain'], { cwd: root })).stdout;
    const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout;
    const body = await refreshProjectProgress(project, [task('active')]);
    const second = await refreshProjectProgress(project, [task('active')]);
    expect(second).toBe(body); // Wall-clock refresh metadata cannot invalidate unchanged advisor inputs.
    expect(body).toContain('revision "');
    expect(await fs.readFile(projectProgressPath(project), 'utf8')).toContain(PROJECT_PROGRESS_MARKER);
    expect(await fs.readFile(path.join(root, 'PROGRESS.md'), 'utf8')).toBe('Authored root status, keep this exact.\n');
    expect((await exec('git', ['status', '--porcelain'], { cwd: root })).stdout).toBe(before);
    expect((await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout).toBe(head);
  });

  it('preserves authored live files and still supplies bounded current context', async () => {
    const { project } = await fixture();
    const file = projectProgressPath(project);
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, 'User-owned content');
    expect(await refreshProjectProgress(project, [task('current')])).toContain('Task current');
    expect(await fs.readFile(file, 'utf8')).toBe('User-owned content');
  });

  it('does not read or clone raw logs and descriptions into the projection', async () => {
    const { project } = await fixture();
    const value = task('minimal');
    Object.defineProperty(value, 'logs', { enumerable: true, get: () => { throw new Error('Raw logs must not be ingested'); } });
    Object.defineProperty(value, 'description', { enumerable: true, get: () => { throw new Error('Task descriptions must not be ingested'); } });
    expect(await refreshProjectProgress(project, [value])).toContain('Task minimal');
  });

  it('does not create a file in unignored state storage', async () => {
    const { project } = await fixture(false);
    expect(await refreshProjectProgress(project, [])).toContain('Live project progress');
    await expect(fs.stat(projectProgressPath(project))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects root/escaping storage and preserves symlink targets', async () => {
    expect(() => projectProgressPath({ path: '/repo', autoBuildPath: '..' })).toThrow();
    expect(() => projectProgressPath({ path: '/repo', autoBuildPath: '.' })).toThrow();
    const { root, project } = await fixture();
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-progress-symlink-'));
    roots.push(target);
    await fs.symlink(target, path.join(root, '.workbench'), 'junction');
    await refreshProjectProgress(project, []);
    expect(await fs.readdir(target)).toEqual([]);
  });

  it('serializes duplicate refreshes without truncation or losing the latest supplied task state', async () => {
    const { project } = await fixture();
    await Promise.all([refreshProjectProgress(project, [task('first')]), refreshProjectProgress(project, [task('last')])]);
    const value = await fs.readFile(projectProgressPath(project), 'utf8');
    expect(value).toContain('Task last');
    expect(value).not.toContain('Task first');
    expect(value.endsWith('\n')).toBe(true);
    expect(await fs.readdir(path.dirname(projectProgressPath(project)))).toEqual(['PROGRESS.md']);
  });
});
