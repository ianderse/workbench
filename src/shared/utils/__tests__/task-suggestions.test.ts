import { describe, it, expect } from 'vitest';
import { extractTaskSuggestions, stripTaskSuggestions } from '../task-suggestions';

describe('task suggestions', () => {
  it('reads every suggestion line', () => {
    const text = 'Sure.\n__TASK_SUGGESTION__:{"title": "Add login", "description": "Add a login page"}\n__TASK_SUGGESTION__:{"title": "T", "description": "D", "metadata": {"category": "feature"}}';
    expect(extractTaskSuggestions(text)).toEqual([
      { title: 'Add login', description: 'Add a login page' },
      { title: 'T', description: 'D' },
    ]);
  });

  it('skips lines without both fields or with broken JSON', () => {
    expect(extractTaskSuggestions('no suggestion here')).toEqual([]);
    expect(extractTaskSuggestions('__TASK_SUGGESTION__:{"title": "only title"}')).toEqual([]);
    expect(extractTaskSuggestions('__TASK_SUGGESTION__:{"title": "T", "descr')).toEqual([]);
  });

  it('takes the lines out of the reply, including one still being streamed', () => {
    expect(stripTaskSuggestions('Answer.\n\n__TASK_SUGGESTION__:{"title": "A", "description": "B"}\n')).toBe('Answer.');
    expect(stripTaskSuggestions('Answer.\n__TASK_SUGG')).toBe('Answer.');
    expect(stripTaskSuggestions('Answer with __init__ and _x')).toBe('Answer with __init__ and _x');
  });
});
