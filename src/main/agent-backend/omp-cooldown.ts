/** Persist provider cooldowns across tasks/restarts; never infer a reset from an ordinary 429. */
import { app } from 'electron';
import { randomUUID } from 'crypto';
import { mkdir, open, readFile, rename, unlink } from 'fs/promises';
import path from 'path';
import type { OmpThinkingLevel } from '../../shared/types/agent-backend';
import type { OmpFallbackChains } from './omp-roles';

export interface OmpProviderCooldown { provider: string; resetAt: string }
export const providerOf = (model: string | undefined): string | undefined => model?.includes('/') ? model.split('/')[0] : undefined;

export class OmpCooldownStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}
  private async read(): Promise<Record<string, OmpProviderCooldown>> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data?.version !== 1 || !data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers)) throw new Error('Invalid OMP provider cooldown file');
      return Object.fromEntries(Object.entries(data.providers).filter(([provider, raw]) => {
        const value = raw as OmpProviderCooldown;
        return value?.provider === provider && Number.isFinite(Date.parse(value.resetAt));
      })) as Record<string, OmpProviderCooldown>;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  async active(now = Date.now()): Promise<Record<string, OmpProviderCooldown>> {
    await this.pending;
    return Object.fromEntries(Object.entries(await this.read()).filter(([, entry]) => Date.parse(entry.resetAt) > now));
  }
  async record(provider: string, resetAt: string): Promise<void> {
    if (!/^[\w.-]+$/.test(provider) || !Number.isFinite(Date.parse(resetAt))) throw new Error('Invalid provider cooldown');
    const write = this.pending.then(async () => {
      const providers = await this.read();
      if (Date.parse(providers[provider]?.resetAt ?? '') >= Date.parse(resetAt)) return;
      providers[provider] = { provider, resetAt };
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, providers }, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, this.file);
      } finally { await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
    });
    this.pending = write.catch(() => undefined);
    await write;
  }
}

export function getOmpCooldownStore(): OmpCooldownStore {
  const file = path.join(app.getPath('userData'), 'omp-provider-cooldowns.json');
  let store = stores.get(file);
  if (!store) { store = new OmpCooldownStore(file); stores.set(file, store); }
  return store;
}
const stores = new Map<string, OmpCooldownStore>();

/** Expand configured exact, provider/prefix wildcard and role chains; never invent a model route. */
export function ompFallbackCandidates(model: string, role: string, chains: OmpFallbackChains, roles: Readonly<Record<string, string>> = {}): Array<{ model: string; thinking?: OmpThinkingLevel }> {
  const keys = Object.keys(chains).filter((key) => key.endsWith('/*') && model.startsWith(key.slice(0, -1))).sort((a, b) => b.length - a.length);
  const values = [model, ...keys, role].flatMap((key) => chains[key] ?? []);
  const bareId = model.slice(model.indexOf('/') + 1);
  const out: Array<{ model: string; thinking?: OmpThinkingLevel }> = [];
  for (const value of values) {
    const resolved = value.startsWith('@') ? roles[value.slice(1)] : value;
    if (!resolved) continue;
    const suffix = resolved.match(/:(off|minimal|low|medium|high|xhigh|max|auto)$/);
    const base = suffix ? resolved.slice(0, -suffix[0].length) : resolved;
    const expanded = base.endsWith('/*') ? `${base.slice(0, -1)}${bareId}` : base;
    if (!providerOf(expanded) || expanded.includes('*') || expanded === model || out.some((entry) => entry.model === expanded)) continue;
    out.push({ model: expanded, ...(suffix && !base.endsWith('/*') ? { thinking: suffix[1] as OmpThinkingLevel } : {}) });
  }
  return out;
}
