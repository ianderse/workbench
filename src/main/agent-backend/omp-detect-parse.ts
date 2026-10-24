/** Parsers for `omp --version` and `omp models` output */
import type { OmpModelInfo } from '../../shared/types/omp-detection';

export function parseOmpVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+[\w.-]*)/.exec(output)?.[1];
}

/** `omp models --json` output: { models: [{ provider, id, selector }] } */
export function parseOmpModelsJson(output: string): OmpModelInfo[] | undefined {
  try {
    const data = JSON.parse(output) as { models?: Array<{ provider?: string; id?: string; selector?: string }> };
    if (!data || !Array.isArray(data.models)) return undefined;
    const models: OmpModelInfo[] = [];
    for (const m of data.models) {
      if (typeof m.provider !== 'string' || typeof m.id !== 'string') continue;
      models.push({ provider: m.provider, id: m.id, selector: m.selector || `${m.provider}/${m.id}` });
    }
    return models;
  } catch {
    return undefined;
  }
}

/** Table output: "provider (n)" heading lines followed by box-drawn rows whose first cell is the model id */
export function parseOmpModelsTable(output: string): OmpModelInfo[] {
  const models: OmpModelInfo[] = [];
  let provider = '';
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^([^\s│┌├└─]+)\s+\(\d+\)$/.exec(line);
    if (heading) {
      provider = heading[1];
      continue;
    }
    if (!provider || !line.startsWith('│')) continue;
    const cell = line.split('│')[1]?.trim();
    if (!cell || cell === 'model') continue;
    models.push({ provider, id: cell, selector: `${provider}/${cell}` });
  }
  return models;
}

export function parseOmpModels(output: string): OmpModelInfo[] {
  return parseOmpModelsJson(output) ?? parseOmpModelsTable(output);
}
