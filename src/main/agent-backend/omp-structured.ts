/**
 * Structured output for the OMP backend
 * =====================================
 *
 * OMP has no `--json-schema`, so a caller's schema is put into the prompt and the answer is
 * parsed out of the model's final text. Local models are flaky about this: they wrap the JSON in
 * prose, add trailing commas or forget keys, so the extractor is tolerant and the caller can ask
 * once more (`buildJsonRepairPrompt`) before giving up.
 */

/** Instruction appended to the prompt of a run that must end with a JSON object */
export function buildStructuredInstruction(schema: Record<string, unknown>): string {
  return `When you finish, output ONLY a single JSON object matching this JSON Schema, inside a \`\`\`json fenced block. Do not write anything after the block.

JSON Schema:
${JSON.stringify(schema, null, 2)}`;
}

/** Follow-up asking for the JSON alone, after an answer that did not contain a usable object */
export function buildJsonRepairPrompt(schema: Record<string, unknown>, previousAnswer?: string): string {
  const previous = previousAnswer?.trim()
    ? `Your previous answer was:\n\n<answer>\n${previousAnswer.trim()}\n</answer>\n\n`
    : '';
  return `${previous}Your answer did not contain a valid JSON object. Reply with ONLY the JSON object, inside a \`\`\`json fenced block, matching this JSON Schema. Do not use any tools and do not add explanations.

JSON Schema:
${JSON.stringify(schema, null, 2)}`;
}

/** Remove trailing commas before a closing bracket (outside strings) */
function stripTrailingCommas(json: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += json[i + 1] ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) j++;
      if (json[j] !== '}' && json[j] !== ']') out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function tryParse(candidate: string): Record<string, unknown> | undefined {
  for (const text of [candidate, stripTrailingCommas(candidate)]) {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // try the next variant
    }
  }
  return undefined;
}

/** Every balanced top-level `{...}` span in the text (string and escape aware) */
function balancedObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
}

/**
 * The JSON object in a model answer: the last ```json fence that parses, else the last balanced
 * top-level `{...}` that parses. Tolerates leading prose and trailing commas.
 */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const fences = [...text.matchAll(/```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i][1].trim();
    const direct = tryParse(body);
    if (direct) return direct;
    const spans = balancedObjects(body);
    for (let j = spans.length - 1; j >= 0; j--) {
      const parsed = tryParse(spans[j]);
      if (parsed) return parsed;
    }
  }
  const spans = balancedObjects(text);
  for (let i = spans.length - 1; i >= 0; i--) {
    const parsed = tryParse(spans[i]);
    if (parsed) return parsed;
  }
  return undefined;
}

/** Light check: every top-level `required` key of the schema is present */
export function hasRequiredKeys(value: Record<string, unknown>, schema: Record<string, unknown>): boolean {
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.every((key) => typeof key !== 'string' || key in value);
}

/** Parse the final answer against a schema; undefined when there is no usable object */
export function parseStructuredOutput(text: string, schema: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = extractJsonObject(text);
  return value && hasRequiredKeys(value, schema) ? value : undefined;
}
