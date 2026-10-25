import { describe, it, expect } from 'vitest';
import { RunProgressTracker, RUN_PROGRESS_INTERVAL_MS, toolTarget } from '../run-progress';

describe('toolTarget', () => {
  it('returns paths relative to the working directory for read-like tools', () => {
    expect(toolTarget('Read', { file_path: '/p/docs/SPEC.md' }, '/p')).toBe('docs/SPEC.md');
    expect(toolTarget('Grep', { pattern: 'foo', path: 'src' }, '/p')).toBe('src');
    expect(toolTarget('Glob', { pattern: 'src/**/*.ts' })).toBe('src/**/*.ts');
  });

  it('ignores other tools and empty input', () => {
    expect(toolTarget('Bash', { command: 'ls' })).toBeUndefined();
    expect(toolTarget('Read', {})).toBeUndefined();
    expect(toolTarget('Read', null)).toBeUndefined();
  });
});

describe('RunProgressTracker', () => {
  it('adds up characters of every kind into tokens and follows the latest stage', () => {
    const tracker = new RunProgressTracker(1000, 'model-x', '/p');
    tracker.delta('thinking', 2400);
    expect(tracker.snapshot(2000)).toMatchObject({ stage: 'thinking', tokens: 600, elapsedMs: 1000, model: 'model-x' });
    tracker.tool('Read', { file_path: '/p/docs/a.md' });
    expect(tracker.snapshot(3000)).toMatchObject({ stage: 'reading', file: 'docs/a.md', tokens: 600 });
    tracker.delta('toolcall', 400);
    tracker.delta('text', 400);
    expect(tracker.snapshot(4000)).toMatchObject({ stage: 'writing', file: 'docs/a.md', tokens: 800 });
  });

  it('throttles to one event per interval, and force overrides', () => {
    const tracker = new RunProgressTracker(0);
    expect(tracker.next(0)).not.toBeNull();
    expect(tracker.next(RUN_PROGRESS_INTERVAL_MS - 1)).toBeNull();
    expect(tracker.next(RUN_PROGRESS_INTERVAL_MS)).not.toBeNull();
    expect(tracker.next(RUN_PROGRESS_INTERVAL_MS + 1)).toBeNull();
    expect(tracker.next(RUN_PROGRESS_INTERVAL_MS + 2, true)).not.toBeNull();
  });

  it('takes the model from the stream when it was unknown', () => {
    const tracker = new RunProgressTracker(0);
    expect(tracker.snapshot(0).model).toBeUndefined();
    tracker.setModel('local/qwen');
    expect(tracker.snapshot(0).model).toBe('local/qwen');
  });
});
