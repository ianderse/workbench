import { describe, it, expect } from 'vitest';
import { buildConversationPrompt, buildSystemPrompt, extractTaskSuggestion, extractToolInput } from '../prompts';

describe('extractTaskSuggestion', () => {
  it('parses a suggestion line', () => {
    const text = 'Sure.\n__TASK_SUGGESTION__:{"title": "Add login", "description": "Add a login page"}\nDone.';
    expect(extractTaskSuggestion(text)).toEqual({ title: 'Add login', description: 'Add a login page' });
  });

  it('ignores extra fields such as the old category metadata', () => {
    const text = '__TASK_SUGGESTION__:{"title": "T", "description": "D", "metadata": {"category": "feature"}}';
    expect(extractTaskSuggestion(text)).toEqual({ title: 'T', description: 'D' });
  });

  it('returns null without a marker or with incomplete JSON fields', () => {
    expect(extractTaskSuggestion('no suggestion here')).toBeNull();
    expect(extractTaskSuggestion('__TASK_SUGGESTION__:{"title": "only title"}')).toBeNull();
  });
});

describe('buildConversationPrompt', () => {
  it('uses the message directly without history', () => {
    expect(buildConversationPrompt('hi')).toBe('hi');
  });

  it('folds history into the prompt', () => {
    const prompt = buildConversationPrompt('next?', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]);
    expect(prompt).toBe('Previous conversation:\nUser: q1\n\nAssistant: a1\n\nCurrent question: next?');
  });
});

describe('extractToolInput', () => {
  it('describes common tool arguments', () => {
    expect(extractToolInput({ command: 'graphify query auth' })).toBe('graphify query auth');
    expect(extractToolInput({ pattern: '*.ts' })).toBe('pattern: *.ts');
    expect(extractToolInput({ file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(extractToolInput({})).toBe('');
  });

  it('keeps whole commands and paths, cutting only very long or multi-line ones', () => {
    const command = 'gh issue view 14 --repo proactive-agent/workbench --json title,body,labels,comments';
    expect(extractToolInput({ command })).toBe(command);
    expect(extractToolInput({ file_path: '/home/me/projects/app/src/renderer/components/Insights.tsx' }))
      .toBe('/home/me/projects/app/src/renderer/components/Insights.tsx');
    expect(extractToolInput({ command: 'gh pr create --body-file - <<EOF\nbody\nEOF' })).toBe('gh pr create --body-file - <<EOF…');
    expect(extractToolInput({ command: 'x'.repeat(600) })).toBe(`${'x'.repeat(500)}…`);
  });
});

describe('buildSystemPrompt', () => {
  it('describes the task tools only when the Kanban button is on', () => {
    const withTools = buildSystemPrompt('/nonexistent-project', { taskTools: true });
    expect(withTools).toContain('mcp__workbench__');
    expect(withTools).toContain("don't create it. Suggest it instead");

    const withoutTools = buildSystemPrompt('/nonexistent-project');
    expect(withoutTools).not.toContain('mcp__workbench__');
    expect(withoutTools).toContain('Kanban button');
    expect(withoutTools).toContain('When the user asks you to create a task');
    expect(withoutTools).toContain('__TASK_SUGGESTION__:');
  });
});
