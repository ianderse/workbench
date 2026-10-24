import { describe, expect, it } from 'vitest';
import { buildJsonRepairPrompt, buildStructuredInstruction, extractJsonObject, parseStructuredOutput } from '../omp-structured';

const schema = { type: 'object', required: ['status', 'summary'], properties: {} };

describe('extractJsonObject', () => {
  it('takes the last json fence', () => {
    const text = 'Draft:\n```json\n{"a":1}\n```\nFinal:\n```json\n{"a":2}\n```';
    expect(extractJsonObject(text)).toEqual({ a: 2 });
  });

  it('finds a bare object after prose', () => {
    expect(extractJsonObject('Sure! Here it is: {"status":"passed","summary":"ok"} hope that helps')).toEqual({ status: 'passed', summary: 'ok' });
  });

  it('tolerates trailing commas', () => {
    expect(extractJsonObject('```json\n{"a":[1,2,],"b":"x,}",}\n```')).toEqual({ a: [1, 2], b: 'x,}' });
  });

  it('is not fooled by braces inside strings', () => {
    expect(extractJsonObject('{"a":"}{","b":2}')).toEqual({ a: '}{', b: 2 });
  });

  it('skips a broken fence and falls back to an earlier valid object', () => {
    expect(extractJsonObject('{"a":1}\nthen ```json\n{nope\n```')).toEqual({ a: 1 });
  });

  it('returns undefined without an object', () => {
    expect(extractJsonObject('no json here')).toBeUndefined();
    expect(extractJsonObject('[1,2,3]')).toBeUndefined();
    expect(extractJsonObject('')).toBeUndefined();
  });
});

describe('parseStructuredOutput', () => {
  it('requires the top-level required keys', () => {
    expect(parseStructuredOutput('{"status":"passed"}', schema)).toBeUndefined();
    expect(parseStructuredOutput('{"status":"passed","summary":"s"}', schema)).toEqual({ status: 'passed', summary: 's' });
  });
});

describe('prompts', () => {
  it('embeds the schema', () => {
    expect(buildStructuredInstruction(schema)).toContain('"required"');
    expect(buildStructuredInstruction(schema)).toContain('```json');
  });

  it('includes the previous answer in a repair prompt when given', () => {
    expect(buildJsonRepairPrompt(schema, 'my answer')).toContain('my answer');
    expect(buildJsonRepairPrompt(schema)).not.toContain('<answer>');
  });
});
