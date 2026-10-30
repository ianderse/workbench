import { describe, it, expect, vi } from 'vitest';
import { createGraphViewSync } from './graph-view-sync';

const view = (k: number) => ({ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], x: 0, y: 0, k });

describe('createGraphViewSync', () => {
  it('lets the first view lead until another is touched', () => {
    const sync = createGraphViewSync();
    const a = Symbol('a');
    const b = Symbol('b');
    sync.join(a, () => {});
    sync.join(b, () => {});
    expect(sync.isLeader(a)).toBe(true);
    sync.lead(b);
    expect(sync.isLeader(b)).toBe(true);
    expect(sync.isLeader(a)).toBe(false);
  });

  it('only takes the leader\'s view', () => {
    const sync = createGraphViewSync();
    const a = Symbol('a');
    const b = Symbol('b');
    sync.join(a, () => {});
    sync.join(b, () => {});
    sync.publish(b, view(2));
    expect(sync.view).toBeNull();
    sync.publish(a, view(3));
    expect(sync.view?.k).toBe(3);
    expect(sync.version).toBe(1);
  });

  it('forwards the leader\'s node drags to the other views only', () => {
    const sync = createGraphViewSync();
    const a = Symbol('a');
    const b = Symbol('b');
    const toA = vi.fn();
    const toB = vi.fn();
    sync.join(a, toA);
    sync.join(b, toB);
    sync.forward(a, { type: 'release', index: 4 });
    expect(toB).toHaveBeenCalledWith({ type: 'release', index: 4 });
    expect(toA).not.toHaveBeenCalled();
  });

  it('hands the lead on when the leader leaves', () => {
    const sync = createGraphViewSync();
    const a = Symbol('a');
    const b = Symbol('b');
    const leaveA = sync.join(a, () => {});
    sync.join(b, () => {});
    leaveA();
    expect(sync.isLeader(b)).toBe(true);
  });
});
