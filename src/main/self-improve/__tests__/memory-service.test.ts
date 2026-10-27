import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Project, Task } from '../../../shared/types';
import { taskHooks } from '../../task-hooks';
import { memoryChanged } from '../memory-events';
import { getCompengDir } from '../paths';
import { startMemoryAutomation } from '../memory-service';
const mocks = vi.hoisted(() => ({
  projects: [] as Project[], tasks: [] as Task[], notify: vi.fn(), send: vi.fn(), capture: vi.fn(async (..._args: unknown[]) => true),
  enabled: vi.fn(async () => true), list: vi.fn(async () => [] as unknown[]), claim: vi.fn(async () => [] as unknown[]), assess: vi.fn(),
}));
vi.mock('../../project-store', () => ({ projectStore: { getProjects: () => mocks.projects, getProject: (id: string) => mocks.projects.find((project) => project.id === id), getTasks: () => mocks.tasks } }));
vi.mock('../../notification-service', () => ({ notificationService: { notifyContent: mocks.notify } }));
vi.mock('../../ipc-handlers/utils', () => ({ safeSendToRenderer: mocks.send }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));
vi.mock('../automatic-capture', () => ({ captureTaskMemory: mocks.capture }));
vi.mock('../setting', () => ({ isSelfImproveEnabledForPath: mocks.enabled }));
vi.mock('../project-memory', () => ({ listProjectMemories: mocks.list, claimMemoryReviewNotice: mocks.claim, reviewAutomaticMemories: mocks.assess }));
let stop: () => void;
let project: Project;
let task: Task;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  project = { id: 'p', name: 'Fixture', path: '/tmp/isolated-memory-service-fixture', settings: { selfImprove: true } } as Project;
  task = { id: 't', specId: '001-fixture', projectId: 'p', status: 'in_progress' } as Task;
  mocks.projects = [project]; mocks.tasks = [task]; mocks.enabled.mockResolvedValue(true); mocks.capture.mockResolvedValue(true); mocks.list.mockResolvedValue([]); mocks.claim.mockResolvedValue([]);
  stop = startMemoryAutomation();
});
afterEach(() => { stop(); vi.useRealTimers(); });
it('reads the persisted completion reason and queues merge reassessment behind extraction', async () => {
  let finish!: (value: boolean) => void;
  mocks.capture.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  mocks.tasks = [{ ...task, status: 'human_review', reviewReason: 'completed' }];
  taskHooks.emit('state', { project, task, status: 'human_review' });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.capture).toHaveBeenCalledTimes(1);
  taskHooks.emit('auto-merged', { project, task, into: 'main' });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.capture).toHaveBeenCalledTimes(1);
  finish(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.capture).toHaveBeenCalledTimes(2);
  expect(mocks.capture.mock.calls[1][2]).toEqual({ target: 'main' });
});
it('ignores non-completion states and disabled projects', async () => {
  mocks.tasks = [{ ...task, status: 'human_review', reviewReason: 'errors' as Task['reviewReason'] }];
  taskHooks.emit('state', { project, task, status: 'human_review' });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.capture).not.toHaveBeenCalled();
  project.settings.selfImprove = false;
  taskHooks.emit('merged', { project, task });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.capture).not.toHaveBeenCalled();
});
it('groups review changes, classifies pending entries, and routes the notice to the memory inbox', async () => {
  mocks.list.mockResolvedValue([{ id: 'm', revision: 1, status: 'proposed' }]);
  mocks.claim.mockResolvedValueOnce([{ reviewReason: 'conflict' }, { reviewReason: 'procedure' }]);
  memoryChanged(getCompengDir(project.path), project.id); memoryChanged(getCompengDir(project.path), project.id);
  await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.assess).toHaveBeenCalledWith(getCompengDir(project.path), project.id, [{ id: 'm', expectedRevision: 1 }]);
  expect(mocks.notify).toHaveBeenCalledTimes(1);
  expect(mocks.notify.mock.calls[0][0]).toMatchObject({ kind: 'review-needed', title: 'Memory conflicts need review in Fixture', route: { projectId: 'p', memoryReview: true } });
  memoryChanged(getCompengDir(project.path), project.id);
  await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.notify).toHaveBeenCalledTimes(1);
});
it('rejects foreign memory directories and respects the live setting for notices', async () => {
  memoryChanged('/tmp/foreign', project.id);
  await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.send).not.toHaveBeenCalled();
  mocks.enabled.mockResolvedValue(false);
  memoryChanged(getCompengDir(project.path), project.id);
  await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.claim).not.toHaveBeenCalled();
});

it('reassesses previously classified proposals so old duplicate conflicts can retire', async () => {
  mocks.list.mockResolvedValue([{ id: 'duplicate', revision: 2, status: 'proposed', reviewReason: 'conflict' }]);
  memoryChanged(getCompengDir(project.path), project.id);
  await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.assess).toHaveBeenCalledWith(getCompengDir(project.path), project.id, [{ id: 'duplicate', expectedRevision: 2 }]);
});
