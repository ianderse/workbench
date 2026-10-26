import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchShape, launchedInBackground } from '../relay/lib/transcript-parser';
import type { WatchedSession } from '../relay/lib/protocol';

const answer = (text: string) => ({ type: 'tool_result', content: [{ type: 'text', text }] });
const launch = answer('Async agent launched successfully. agentId: a1');

describe('launchedInBackground', () => {
  it('takes a toolUseResult that says how the agent ran at its word', () => {
    expect(launchedInBackground({ status: 'async_launched' }, answer('anything'))).toBe(true);
    expect(launchedInBackground({ isAsync: true }, answer('anything'))).toBe(true);
    // A foreground report that happens to start with the launch answer is still its end
    expect(launchedInBackground({ status: 'completed' }, launch)).toBe(false);
  });

  it('reads the answer when there is no toolUseResult, or one that does not say', () => {
    expect(launchedInBackground(undefined, launch)).toBe(true);
    expect(launchedInBackground([{ type: 'text', text: 'x' }], launch)).toBe(true);
    expect(launchedInBackground({ agentId: 'a1' }, launch)).toBe(true);
    expect(launchedInBackground({ agentId: 'a1' }, answer('Done: all checks pass'))).toBe(false);
  });

  it("goes by the launched agent's .meta.json only where the answer does not say it went async", () => {
    // A sub-agent's transcript has no toolUseResult: an answer that doesn't say is settled by the requestShape
    expect(launchedInBackground(undefined, answer('Agent started in the background'), () => 'background')).toBe(true);
    expect(launchedInBackground(undefined, answer('Done: all checks pass'), () => 'foreground')).toBe(false);
    // A foreground launch moved to the background later (Ctrl+B): its .meta.json still says foreground
    expect(launchedInBackground(undefined, launch, () => 'foreground')).toBe(true);
    // Not written yet: the wording is all there is
    expect(launchedInBackground(undefined, launch, () => undefined)).toBe(true);
    expect(launchedInBackground(undefined, answer('Done: all checks pass'), () => undefined)).toBe(false);
    // A toolUseResult that says how it ran never needs the .meta.json
    const shape = vi.fn(() => 'background' as const);
    expect(launchedInBackground({ status: 'completed' }, launch, shape)).toBe(false);
    expect(shape).not.toHaveBeenCalled();
  });

  it('takes a failed call for its end, whatever its .meta.json says', () => {
    const failed = { ...launch, is_error: true };
    expect(launchedInBackground(undefined, failed, () => 'background')).toBe(false);
    expect(launchedInBackground({ isAsync: true }, failed)).toBe(false);
  });
});

describe('launchShape', () => {
  it('reads a .meta.json again until it says both which call launched it and how', () => {
    const subagentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-shape-'));
    const session = { subagentsDir, launchShapes: new Map(), readLaunchMetas: new Set() } as unknown as WatchedSession;
    const meta = path.join(subagentsDir, 'agent-a1.meta.json');
    try {
      fs.writeFileSync(meta, JSON.stringify({ agentType: 'general-purpose' }));
      expect(launchShape(session, 'toolu_1')).toBeUndefined();
      fs.writeFileSync(meta, JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_1', requestShape: 'background' }));
      expect(launchShape(session, 'toolu_1')).toBe('background');
    } finally {
      fs.rmSync(subagentsDir, { recursive: true, force: true });
    }
  });
});
