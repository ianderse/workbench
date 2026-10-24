import { describe, expect, it } from 'vitest';
import { DEFAULT_OMP_BACKEND_SETTINGS } from '../../../shared/types/agent-backend';
import { buildOmpAdvisorOverlay, buildOmpArgs, modelAliasOf, ompModelFor, ompToolsFromClaude, resolveOmpAdvisor } from '../omp-args';

const settings = { ...DEFAULT_OMP_BACKEND_SETTINGS, models: { haiku: 'ollama/small', opus: 'lmstudio/big' }, extraArgs: ['--no-lsp'] };

describe('omp args', () => {
  it('maps model tiers, including full Claude ids, and omits unmapped ones', () => {
    expect(ompModelFor('haiku', settings)).toBe('ollama/small');
    expect(ompModelFor('claude-opus-4-1', settings)).toBe('lmstudio/big');
    expect(ompModelFor('sonnet', settings)).toBeUndefined();
    expect(ompModelFor('something-else', settings)).toBeUndefined();
    expect(modelAliasOf(undefined)).toBeUndefined();
  });

  it('maps Claude tools', () => {
    expect(ompToolsFromClaude(['Read', 'Glob', 'Grep'])).toEqual(['read', 'find', 'glob', 'grep']);
    expect(ompToolsFromClaude([], ['Bash(git log *)', 'Edit'])).toEqual(['bash', 'edit']);
    expect(ompToolsFromClaude([])).toEqual([]);
  });

  it('builds a one-shot command line', () => {
    const args = buildOmpArgs({ settings, model: 'haiku', effort: 'medium', tools: [], oneShot: true, maxTimeMinutes: 2 });
    expect(args).toEqual(['-p', '--mode', 'json', '--no-title', '--no-session', '--model', 'ollama/small', '--thinking', 'low', '--no-tools', '--max-time', '2m', '--no-extensions', '--no-skills', '--no-lsp']);
  });

  it('builds a persistent, resumed, full-access command line', () => {
    const args = buildOmpArgs({ settings, tools: 'all', session: { dir: '/s', resume: 'abc' }, systemPromptFile: '/p.md', attachmentPaths: ['/a.png'] });
    expect(args).toContain('--auto-approve');
    expect(args).not.toContain('--tools');
    expect(args.slice(args.indexOf('--session-dir'), args.indexOf('--session-dir') + 4)).toEqual(['--session-dir', '/s', '--resume', 'abc']);
    expect(args[args.length - 1]).toBe('@/a.png');
  });

  it('auto-approves only when tools can change things', () => {
    expect(buildOmpArgs({ settings, tools: ['read', 'grep'] })).not.toContain('--auto-approve');
    expect(buildOmpArgs({ settings, tools: ['read', 'bash'] })).toContain('--auto-approve');
    expect(buildOmpArgs({ settings, tools: ['read'], autoApprove: false })).not.toContain('--auto-approve');
  });
});

describe('omp advisor', () => {
  it('adds --advisor when on and --config when an overlay file is given', () => {
    const args = buildOmpArgs({ settings, tools: 'all', advisorMode: 'on', advisorOverlayFile: '/t/overlay.yml' });
    expect(args).toContain('--advisor');
    expect(args.slice(args.indexOf('--config'), args.indexOf('--config') + 2)).toEqual(['--config', '/t/overlay.yml']);
    const inherit = buildOmpArgs({ settings, tools: 'all', advisorMode: 'inherit' });
    expect(inherit).not.toContain('--advisor');
    expect(inherit).not.toContain('--config');
  });

  it('resolves the advisor from the settings and forces it off for one-shot calls', () => {
    expect(resolveOmpAdvisor(settings)).toEqual({ mode: 'inherit' });
    expect(resolveOmpAdvisor({ ...settings, advisor: 'on', advisorModel: ' omlx/big ' })).toEqual({ mode: 'on', model: 'omlx/big' });
    expect(resolveOmpAdvisor({ ...settings, advisor: 'on', advisorModel: 'omlx/big' }, true)).toEqual({ mode: 'off' });
  });

  it('writes an overlay only when flags alone cannot do it', () => {
    expect(buildOmpAdvisorOverlay({ mode: 'inherit' })).toBeUndefined();
    expect(buildOmpAdvisorOverlay({ mode: 'on' })).toBeUndefined();
    expect(buildOmpAdvisorOverlay({ mode: 'off' })).toBe('advisor:\n  enabled: false\n');
    expect(buildOmpAdvisorOverlay({ mode: 'off', model: 'omlx/big' })).toBe('advisor:\n  enabled: false\n');
    expect(buildOmpAdvisorOverlay({ mode: 'inherit', model: 'omlx/big' })).toBe('modelRoles:\n  advisor: "omlx/big"\n');
    expect(buildOmpAdvisorOverlay({ mode: 'on', model: 'omlx/big' })).toBe('modelRoles:\n  advisor: "omlx/big"\nadvisor:\n  enabled: true\n');
  });
});
