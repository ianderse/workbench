import { describe, expect, it } from 'vitest';
import { estimateTokens, StreamProgress } from '../stream-progress';

describe('StreamProgress', () => {
  it('estimates tokens as chars / 4', () => {
    expect(estimateTokens(4000)).toBe(1000);
  });

  it('reports at most once per interval and keeps counting', () => {
    const progress = new StreamProgress(60_000);
    expect(progress.add(400, 0)).toBeUndefined();
    expect(progress.add(400, 30_000)).toBeUndefined();
    expect(progress.add(1200, 60_000)).toBe('Model is writing… ~500 tokens so far (1 min into this reply)');
    expect(progress.add(400, 90_000)).toBeUndefined();
    expect(progress.add(400, 120_000)).toBe('Model is writing… ~700 tokens so far (2 min into this reply)');
  });

  it('starts a fresh count after reset', () => {
    const progress = new StreamProgress(60_000);
    progress.add(4000, 0);
    progress.reset();
    expect(progress.add(40, 200_000)).toBeUndefined();
    expect(progress.add(40, 260_000)).toBe('Model is writing… ~20 tokens so far (1 min into this reply)');
  });
});
