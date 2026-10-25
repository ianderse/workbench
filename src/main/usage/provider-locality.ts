/**
 * Local or cloud: where a provider's tokens ran
 *
 * A provider is local when its `baseUrl` in OMP's `models.yml` points at this machine or the LAN,
 * or when it is a well-known local runtime (omlx, ollama, LM Studio, llama.cpp ...). Anything else
 * (Anthropic, OpenAI, Google ...) is cloud.
 */
import os from 'os';
import path from 'path';
import { promises as fsp } from 'fs';
import { appLog } from '../app-logger';
import type { UsageLocality } from '../../shared/types/usage';

const LOCAL_PROVIDER_NAMES = /^(?:omlx|ollama|lm[-_ ]?studio|lmstudio|llama[-_. ]?cpp|llamacpp|llama[-_]?server|mlx|vllm|koboldcpp|jan|local|localhost)$/i;

/** True for a host on this machine or on a private network */
export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa') || h.endsWith('.internal')) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ip) {
    const a = Number(ip[1]);
    const b = Number(ip[2]);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  // IPv6 unique-local and link-local ranges
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

/** Host of a base URL; undefined when it does not parse */
function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(/^[a-z]+:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Locality of a provider. `baseUrls` is provider name -> base URL from OMP's models.yml; its answer
 * wins over the name, since a user can run a "custom" provider against a local server.
 */
export function classifyProvider(provider: string | undefined, baseUrls: ReadonlyMap<string, string> = new Map()): UsageLocality {
  if (!provider) return 'cloud';
  const baseUrl = baseUrls.get(provider);
  if (baseUrl) {
    const host = hostOf(baseUrl);
    if (host) return isLocalHost(host) ? 'local' : 'cloud';
  }
  return LOCAL_PROVIDER_NAMES.test(provider.trim()) ? 'local' : 'cloud';
}

/**
 * `providers:` -> `<name>:` -> `baseUrl:` of an OMP models.yml, read line by line (the file is
 * small and regular; a YAML parser would be a new dependency for one field).
 */
export function parseModelsYmlBaseUrls(text: string): Map<string, string> {
  const result = new Map<string, string>();
  let inProviders = false;
  let providerIndent = -1;
  let current: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      inProviders = /^providers\s*:/.test(line);
      providerIndent = -1;
      current = undefined;
      continue;
    }
    if (!inProviders) continue;
    if (providerIndent === -1) providerIndent = indent;
    if (indent === providerIndent) {
      const name = /^["']?([^"':]+)["']?\s*:/.exec(line)?.[1]?.trim();
      current = name || undefined;
      continue;
    }
    if (current && indent > providerIndent) {
      const match = /^(?:baseUrl|base_url|baseURL)\s*:\s*["']?([^"'\s#]+)/.exec(line);
      if (match) result.set(current, match[1]);
    }
  }
  return result;
}

const REFRESH_MS = 5 * 60 * 1000;
let cached: { at: number; value: Map<string, string> } | undefined;

/** Provider base URLs from OMP's models.yml (read-only, async, cached for a few minutes) */
export async function readProviderBaseUrls(): Promise<Map<string, string>> {
  if (cached && Date.now() - cached.at < REFRESH_MS) return cached.value;
  let value = new Map<string, string>();
  try {
    value = parseModelsYmlBaseUrls(await fsp.readFile(path.join(os.homedir(), '.omp', 'agent', 'models.yml'), 'utf-8'));
  } catch (error) {
    // No OMP config: the provider names alone decide
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') appLog.warn('[Usage] Could not read OMP models.yml:', error);
  }
  cached = { at: Date.now(), value };
  return value;
}
