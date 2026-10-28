import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';

export interface CheckpointAttempt {
  attempt: number;
  status: 'pending' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  artifact: string;
}
export interface CheckpointRecord<T = unknown> {
  version: 1;
  key: string;
  /** Full bounded-call inputs remain available here even when the model prompt uses a reference. */
  path: string;
  metadata: unknown;
  metadataDigest: string;
  attempt: number;
  status: 'pending' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  result?: T;
  error?: string;
  history: CheckpointAttempt[];
}

const active = new Set<string>();
const queues = new Map<string, Promise<unknown>>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const directoryOf = (specDir: string, key: string) => path.join(specDir, 'checkpoints', hash(key));

function jsonCopy<T>(value: T): T {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Checkpoint data must be JSON serializable');
  return JSON.parse(text) as T;
}
function stable(value: unknown): string {
  const canonical = (data: unknown): string => {
    if (Array.isArray(data)) return `[${data.map(canonical).join(',')}]`;
    if (data && typeof data === 'object') return `{${Object.keys(data).sort().map((key) => `${JSON.stringify(key)}:${canonical((data as Record<string, unknown>)[key])}`).join(',')}}`;
    return JSON.stringify(data)!;
  };
  return canonical(jsonCopy(value));
}

function validate(record: CheckpointRecord, directory: string, key: string): void {
  const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (!record || record.version !== 1 || record.key !== key || record.path !== path.join(directory, 'checkpoint.json')
    || !/^[a-f0-9]{64}$/.test(record.metadataDigest) || hash(stable(record.metadata)) !== record.metadataDigest
    || !Number.isInteger(record.attempt) || record.attempt < 1 || record.attempt > 10 || !['pending', 'completed', 'failed'].includes(record.status)
    || !date(record.startedAt) || !Array.isArray(record.history) || record.history.length !== record.attempt - 1) throw new Error('Malformed checkpoint record');
  if (record.history.some((attempt, index) => attempt.attempt !== index + 1 || attempt.status !== 'failed' || !date(attempt.startedAt) || !date(attempt.finishedAt)
    || attempt.artifact !== path.join(directory, `attempt-${index + 1}.failed.json`))) throw new Error('Malformed checkpoint attempt history');
  if (record.status === 'completed' && (!Object.hasOwn(record, 'result') || Object.hasOwn(record, 'error') || !date(record.finishedAt))) throw new Error('Malformed completed checkpoint');
  if (record.status === 'failed' && (typeof record.error !== 'string' || !record.error || Object.hasOwn(record, 'result') || !date(record.finishedAt))) throw new Error('Malformed failed checkpoint');
  if (record.status === 'pending' && (record.finishedAt !== undefined || Object.hasOwn(record, 'result') || Object.hasOwn(record, 'error'))) throw new Error('Malformed pending checkpoint');
}

async function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(operation);
  queues.set(key, next);
  try { return await next; }
  finally { if (queues.get(key) === next) queues.delete(key); }
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  catch (error) { await handle.close().catch(() => undefined); await fs.unlink(temporary).catch(() => undefined); throw error; }
  await handle.close();
  try { await fs.rename(temporary, file); await syncDirectory(path.dirname(file)); }
  catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

async function read<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function writeImmutable(file: string, value: unknown): Promise<unknown> {
  const previous = await read<unknown>(file);
  if (previous !== undefined) return previous;
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.link(temporary, file); await syncDirectory(path.dirname(file)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return await read(file);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
  return value;
}

async function latestAttempt<T>(directory: string): Promise<CheckpointRecord<T> | undefined> {
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const artifacts = names.map((name) => ({ name, match: /^attempt-(\d+)\.(pending|completed|failed)\.json$/.exec(name) }))
    .filter((item) => item.match)
    .sort((a, b) => Number(b.match![1]) - Number(a.match![1]) || Number(a.match![2] === 'pending') - Number(b.match![2] === 'pending'));
  if (!artifacts.length) return undefined;
  const selected = artifacts[0];
  const record = await read<CheckpointRecord<T>>(path.join(directory, selected.name));
  if (record && (record.attempt !== Number(selected.match![1]) || record.status !== selected.match![2])) throw new Error('Malformed checkpoint attempt artifact');
  return record;
}

async function finish<T>(specDir: string, key: string, attempt: number, outcome: { result: T } | { error: string }): Promise<CheckpointRecord<T>> {
  const directory = directoryOf(specDir, key);
  return serial(directory, async () => {
    const file = path.join(directory, 'checkpoint.json');
    let current = await read<CheckpointRecord<T>>(file);
    if (!current || current.key !== key || current.attempt !== attempt) throw new Error('Checkpoint attempt changed before completion');
    validate(current, directory, key);
    const completed = await read<CheckpointRecord<T>>(path.join(directory, `attempt-${attempt}.completed.json`));
    const failed = await read<CheckpointRecord<T>>(path.join(directory, `attempt-${attempt}.failed.json`));
    if (completed && failed) throw new Error('Conflicting checkpoint terminal artifacts');
    const recovered = completed ?? failed;
    if (recovered) {
      validate(recovered, directory, key);
      if (recovered.key !== key || recovered.attempt !== attempt || recovered.metadataDigest !== current.metadataDigest) throw new Error('Invalid checkpoint terminal artifact');
      current = recovered;
      await writeAtomic(file, current);
      active.delete(directory);
    }
    const status = 'result' in outcome ? 'completed' : 'failed';
    if (current.status !== 'pending') {
      if (current.status === status && (status === 'completed' ? stable(current.result) === stable((outcome as { result: T }).result) : current.error === (outcome as { error: string }).error)) return current;
      throw new Error('A checkpoint terminal result cannot be replaced');
    }
    const terminal: CheckpointRecord<T> = { ...current, ...outcome, status, finishedAt: new Date().toISOString() };
    validate(terminal, directory, key);
    const artifact = path.join(directory, `attempt-${attempt}.${status}.json`);
    const preserved = await writeImmutable(artifact, terminal) as CheckpointRecord<T>;
    if (preserved.key !== key || preserved.attempt !== attempt || preserved.status !== status
      || (status === 'completed' ? stable(preserved.result) !== stable(terminal.result) : preserved.error !== terminal.error)) throw new Error('Conflicting checkpoint terminal artifact');
    await writeAtomic(file, preserved);
    active.delete(directory);
    return preserved;
  });
}

/** A pending prior-process attempt is retried, not reused as successful advice. */
export async function beginCheckpoint<T = unknown>(specDir: string, key: string, metadata: unknown, maxAttempts = 2): Promise<{ record: CheckpointRecord<T>; execute: boolean; cached: boolean }> {
  if (!key.trim() || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('Invalid checkpoint key or attempt limit');
  const directory = directoryOf(specDir, key);
  return serial(directory, async () => {
    const file = path.join(directory, 'checkpoint.json');
    let current = await read<CheckpointRecord<T>>(file);
    const normalizedMetadata = jsonCopy(metadata);
    const metadataDigest = hash(stable(normalizedMetadata));
    if (current) validate(current, directory, key);
    const latest = await latestAttempt<T>(directory);
    if (latest && (!current || latest.attempt > current.attempt)) {
      validate(latest, directory, key);
      current = latest;
      await writeAtomic(file, latest);
    }
    if (current && (current.key !== key || current.metadataDigest !== metadataDigest || current.path !== file)) throw new Error('Checkpoint inputs do not match its durable key');
    if (current) {
      // A terminal artifact can survive a crash between writing it and publishing the current pointer.
      const completed = await read<CheckpointRecord<T>>(path.join(directory, `attempt-${current.attempt}.completed.json`));
      const failed = await read<CheckpointRecord<T>>(path.join(directory, `attempt-${current.attempt}.failed.json`));
      if (completed && failed) throw new Error('Conflicting checkpoint terminal artifacts');
      const terminal = completed ?? failed;
      if (terminal) {
        validate(terminal, directory, key);
        if (terminal.key !== key || terminal.attempt !== current.attempt || terminal.metadataDigest !== metadataDigest || !['completed', 'failed'].includes(terminal.status)) throw new Error('Invalid checkpoint recovery artifact');
        current = terminal;
        await writeAtomic(file, terminal);
        active.delete(directory);
      } else if (current.status !== 'pending') throw new Error('A checkpoint terminal artifact is missing');
      else if (active.has(directory)) return { record: current, execute: false, cached: false };
      else {
        current = { ...current, status: 'failed', error: 'Checkpoint interrupted before a terminal result was recorded', finishedAt: new Date().toISOString() };
        await writeImmutable(path.join(directory, `attempt-${current.attempt}.failed.json`), current);
        await writeAtomic(file, current);
      }
    }
    if (current?.status === 'completed') return { record: current, execute: false, cached: true };
    if (current && current.attempt >= maxAttempts) return { record: current, execute: false, cached: false };
    const startedAt = new Date().toISOString();
    const attempt = (current?.attempt ?? 0) + 1;
    const history = current ? [...current.history, { attempt: current.attempt, status: current.status, startedAt: current.startedAt, finishedAt: current.finishedAt, artifact: path.join(directory, `attempt-${current.attempt}.${current.status}.json`) }] : [];
    const record: CheckpointRecord<T> = { version: 1, key, path: file, metadata: normalizedMetadata, metadataDigest, attempt, status: 'pending', startedAt, history };
    await fs.mkdir(directory, { recursive: true });
    await writeImmutable(path.join(directory, `attempt-${attempt}.pending.json`), record);
    await writeAtomic(file, record);
    active.add(directory);
    return { record, execute: true, cached: false };
  });
}

export function completeCheckpoint<T>(specDir: string, key: string, attempt: number, result: T): Promise<CheckpointRecord<T>> {
  return finish(specDir, key, attempt, { result: jsonCopy(result) });
}

export function failCheckpoint(specDir: string, key: string, attempt: number, error: string): Promise<CheckpointRecord> {
  return finish(specDir, key, attempt, { error });
}
