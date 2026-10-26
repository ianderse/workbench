import { describe, it, expect, vi } from 'vitest';
import { launchedInBackground } from '../relay/lib/transcript-parser';

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

  it("goes by the launched agent's .meta.json before the answer's wording", () => {
    // A sub-agent's transcript has no toolUseResult: the requestShape decides, whatever the answer says
    expect(launchedInBackground(undefined, answer('Agent started in the background'), () => 'background')).toBe(true);
    expect(launchedInBackground(undefined, launch, () => 'foreground')).toBe(false);
    // Not written yet: the wording is all there is
    expect(launchedInBackground(undefined, launch, () => undefined)).toBe(true);
    // A toolUseResult that says how it ran never needs the .meta.json
    const shape = vi.fn(() => 'background' as const);
    expect(launchedInBackground({ status: 'completed' }, launch, shape)).toBe(false);
    expect(shape).not.toHaveBeenCalled();
  });
});
