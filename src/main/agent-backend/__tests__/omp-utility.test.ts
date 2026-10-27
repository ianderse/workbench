import { expect, it, vi } from 'vitest';
import { buildOmpUtilityExtension } from '../omp-utility';

it('removes ambient tools and context at the utility boundary without mutating the provider payload', async () => {
  const handlers = new Map<string, (event?: unknown) => unknown>();
  const setActiveTools = vi.fn(async () => {});
  const load = new Function(buildOmpUtilityExtension('Extract useful project memories.', 'Return JSON.').replace('export default function', 'return function'))() as (api: unknown) => void;
  load({ on: (name: string, handler: (event?: unknown) => unknown) => handlers.set(name, handler), setActiveTools });
  expect(await handlers.get('before_agent_start')!()).toEqual({ systemPrompt: 'Extract useful project memories.\n\nReturn JSON.' });
  expect(setActiveTools).toHaveBeenCalledWith([]);
  const payload = { model: 'fixture', messages: [{ role: 'user', content: 'Outcome' }], tools: Array.from({ length: 103 }, (_, i) => ({ name: `mcp_fixture_${i}` })), tool_choice: 'auto' };
  const result = handlers.get('before_provider_request')!({ payload }) as Record<string, unknown>;
  expect(result).toEqual({ model: 'fixture', messages: payload.messages });
  expect(payload.tools).toHaveLength(103);
  expect(handlers.get('tool_call')!()).toMatchObject({ block: true });
});

it('treats quotes and source-like prompt text as data and rejects unsupported payload shapes', async () => {
  const prompt = '"; throw new Error("prompt executed"); ` ${untrusted}';
  const handlers = new Map<string, (event?: unknown) => unknown>();
  const load = new Function(buildOmpUtilityExtension(prompt).replace('export default function', 'return function'))() as (api: unknown) => void;
  load({ on: (name: string, handler: (event?: unknown) => unknown) => handlers.set(name, handler), setActiveTools: async () => {} });
  expect(await handlers.get('before_agent_start')!()).toEqual({ systemPrompt: prompt });
  expect(() => handlers.get('before_provider_request')!({ payload: null })).toThrow('Unsupported');
});
