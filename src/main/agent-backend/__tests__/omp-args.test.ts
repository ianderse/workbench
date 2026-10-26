import { describe, expect, it } from 'vitest';
import { DEFAULT_OMP_BACKEND_SETTINGS } from '../../../shared/types/agent-backend';
import { buildOmpAdvisorOverlay, buildOmpArgs, modelAliasOf, ompMaxRetries, ompModelFor, ompRoleForJob, ompToolsFromClaude, resolveOmpAdvisor } from '../omp-args';

const settings = { ...DEFAULT_OMP_BACKEND_SETTINGS, models: { haiku: 'ollama/small', opus: 'lmstudio/big' }, extraArgs: ['--no-lsp'] };

describe('omp args', () => {
  it('maps model tiers, including full Claude ids, and omits unmapped ones', () => {
    expect(ompModelFor('haiku', settings)).toBe('ollama/small');
    expect(ompModelFor('claude-opus-4-1', settings)).toBe('lmstudio/big');
    expect(ompModelFor('sonnet', settings)).toBeUndefined();
    expect(ompModelFor('something-else', settings)).toBeUndefined();
    expect(modelAliasOf(undefined)).toBeUndefined();
  });

  it('passes an exact provider/model selector through, bypassing the tier map', () => {
    expect(ompModelFor('omlx/Qwen3.8-27B-oQ8e-mtp', settings)).toBe('omlx/Qwen3.8-27B-oQ8e-mtp');
    expect(ompModelFor('opus', settings)).toBe('lmstudio/big');
  });

  it('maps Claude tools', () => {
    expect(ompToolsFromClaude(['Read', 'Glob', 'Grep'])).toEqual(['read', 'glob', 'grep']);
    expect(ompToolsFromClaude([], ['Bash(git log *)', 'Edit'])).toEqual(['bash', 'edit']);
    expect(ompToolsFromClaude([])).toEqual([]);
  });

  it('loads extension files with -e, also with --no-extensions, and lists extra tool names', () => {
    const args = buildOmpArgs({ settings: { ...settings, extraArgs: [] }, tools: ['read', 'message_task'], extensionPaths: ['/tmp/x/workbench-messaging.mjs'], oneShot: true });
    expect(args).toContain('--no-extensions');
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', 'read,message_task']);
    expect(args.slice(args.indexOf('-e'), args.indexOf('-e') + 2)).toEqual(['-e', '/tmp/x/workbench-messaging.mjs']);
    expect(buildOmpArgs({ settings, tools: 'all' })).not.toContain('-e');
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

  it('caps subagents per run so one task cannot swamp the model server', () => {
    expect(buildOmpAdvisorOverlay({ mode: 'inherit' }, false, 3)).toBe('retry:\n  modelFallback: true\n  fallbackOn: usage-limit\ntask:\n  maxConcurrency: 3\n');
    // 0 means the agent works alone, but a stray task call still gets a cap of 1
    expect(buildOmpAdvisorOverlay({ mode: 'inherit' }, true, 0)).toBe('task:\n  maxConcurrency: 1\n');
    expect(buildOmpAdvisorOverlay({ mode: 'inherit' }, true)).toBeUndefined();
  });

  it('writes an overlay only when flags alone cannot do it', () => {
    expect(buildOmpAdvisorOverlay({ mode: 'inherit' }, true)).toBeUndefined();
    expect(buildOmpAdvisorOverlay({ mode: 'on' }, true)).toBeUndefined();
    expect(buildOmpAdvisorOverlay({ mode: 'off' }, true)).toBe('advisor:\n  enabled: false\n');
    expect(buildOmpAdvisorOverlay({ mode: 'off', model: 'omlx/big' }, true)).toBe('advisor:\n  enabled: false\n');
    expect(buildOmpAdvisorOverlay({ mode: 'inherit', model: 'omlx/big' }, true)).toBe('modelRoles:\n  advisor: "omlx/big"\n');
    // Fallback models are used only on a usage limit, unless the final attempt of a task phase allows them
    expect(buildOmpAdvisorOverlay({ mode: 'inherit' })).toBe('retry:\n  modelFallback: true\n  fallbackOn: usage-limit\n');
    expect(buildOmpAdvisorOverlay({ mode: 'off' }, false)).toBe('advisor:\n  enabled: false\n' + 'retry:\n  modelFallback: true\n  fallbackOn: usage-limit\n');
    expect(buildOmpAdvisorOverlay({ mode: 'inherit' }, true)).toBeUndefined();
    expect(buildOmpAdvisorOverlay({ mode: 'off' }, true)).toBe('advisor:\n  enabled: false\n');
    expect(buildOmpAdvisorOverlay({ mode: 'on', model: 'omlx/big' }, true)).toBe('modelRoles:\n  advisor: "omlx/big"\nadvisor:\n  enabled: true\n');
  });
});

describe('omp roles per job', () => {
  const roles = { default: 'omlx/flash', plan: 'anthropic/opus', judge: 'anthropic/sonnet' };

  it('maps jobs to roles', () => {
    expect(ompRoleForJob('plan')).toBe('plan');
    expect(ompRoleForJob('review')).toBe('judge');
    for (const job of ['implement', 'validate', 'revise', 'utility'] as const) expect(ompRoleForJob(job)).toBe('default');
  });

  it('uses the job role when the size has no mapping', () => {
    expect(ompModelFor('sonnet', settings, 'plan', roles)).toBe('@plan');
    expect(ompModelFor('sonnet', settings, 'default', roles)).toBe('@default');
    expect(ompModelFor('sonnet', settings, 'judge', roles)).toBe('@judge');
  });

  it('lets a size mapping or an exact pin win over the role', () => {
    expect(ompModelFor('opus', settings, 'plan', roles)).toBe('lmstudio/big');
    expect(ompModelFor('omlx/pinned', settings, 'judge', roles)).toBe('omlx/pinned');
  });

  it('only uses roles the OMP config defines', () => {
    expect(ompModelFor('sonnet', settings, 'judge', { default: 'omlx/flash' })).toBe('@default');
    expect(ompModelFor('sonnet', settings, 'plan', { judge: 'x/y' })).toBeUndefined();
    expect(ompModelFor('sonnet', settings, 'plan', undefined)).toBeUndefined();
    expect(ompModelFor('sonnet', settings, undefined, roles)).toBeUndefined();
  });

  it('puts the role in the command line', () => {
    const args = buildOmpArgs({ settings, model: 'sonnet', role: 'plan', roles, tools: [] });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', '@plan']);
    expect(buildOmpArgs({ settings, model: 'sonnet', role: 'plan', tools: [] })).not.toContain('--model');
  });

  it('clamps the retry count', () => {
    expect(ompMaxRetries({})).toBe(5);
    expect(ompMaxRetries({ retries: 0 })).toBe(0);
    expect(ompMaxRetries({ retries: 99 })).toBe(10);
    expect(ompMaxRetries({ retries: -2 })).toBe(0);
    expect(ompMaxRetries({ retries: 3 })).toBe(3);
  });
});
