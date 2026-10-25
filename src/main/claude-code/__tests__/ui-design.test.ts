import { describe, it, expect } from 'vitest';
import { DESIGN_MODEL, OMP_DESIGN_MODEL, designModelFor, extractDesignSpec } from '../ui-design';
import { applyUiWorkPlanning } from '../triage';
import { ompConfiguredRole, ompModelFor, ompRoleForJob, ompRoleSelector } from '../../agent-backend/omp-args';
import { DEFAULT_OMP_BACKEND_SETTINGS } from '../../../shared/types/agent-backend';
import { isUiTask, resolveUiImplementer, resolveUiWork, usesDesignModel, type UiPhase } from '../../../shared/utils/ui-work';
import type { TaskTriage } from '../../../shared/types/claude-code';

const base: TaskTriage = {
  model: 'sonnet', effort: 'medium', needsPlan: false, scope: 'small', title: 't', reasoning: '', verification: [], source: 'auto',
};

describe('resolveUiWork', () => {
  it('lets the ticket force UI work on or off, else triage decides, missing means false', () => {
    expect(resolveUiWork(true, false)).toBe(true);
    expect(resolveUiWork(false, true)).toBe(false);
    expect(resolveUiWork(undefined, true)).toBe(true);
    expect(resolveUiWork(undefined, false)).toBe(false);
    expect(resolveUiWork(undefined, undefined)).toBe(false);
  });

  it('isUiTask reads the ticket, then the run triage', () => {
    expect(isUiTask({ metadata: { uiWork: false }, claudeRun: { triage: { uiWork: true } } })).toBe(false);
    expect(isUiTask({ claudeRun: { triage: { uiWork: true } } })).toBe(true);
    expect(isUiTask({})).toBe(false);
  });
});

describe('resolveUiImplementer', () => {
  it('defaults to the design model', () => {
    expect(resolveUiImplementer(undefined)).toBe('design');
    expect(resolveUiImplementer({})).toBe('design');
    expect(resolveUiImplementer({ uiImplementer: 'default' })).toBe('default');
    expect(resolveUiImplementer({ uiImplementer: 'design' })).toBe('design');
  });
});

describe('usesDesignModel', () => {
  const phases: UiPhase[] = ['plan', 'implement', 'revise', 'validate', 'resync', 'review', 'spec_review'];

  it('never applies to a task that is not UI work', () => {
    for (const phase of phases) expect(usesDesignModel(phase, false, 'design')).toBe(false);
  });

  it('plans with the design model and builds with it unless the task model implements', () => {
    expect(usesDesignModel('plan', true, 'default')).toBe(true);
    expect(usesDesignModel('plan', true, 'design')).toBe(true);
    for (const phase of ['implement', 'revise', 'validate'] as const) {
      expect(usesDesignModel(phase, true, 'design')).toBe(true);
      expect(usesDesignModel(phase, true, 'default')).toBe(false);
    }
    for (const phase of ['resync', 'review', 'spec_review'] as const) expect(usesDesignModel(phase, true, 'design')).toBe(false);
  });
});

describe('applyUiWorkPlanning', () => {
  it('forces planning on for UI work from triage or the ticket', () => {
    expect(applyUiWorkPlanning({ ...base, uiWork: true }, undefined).needsPlan).toBe(true);
    expect(applyUiWorkPlanning(base, true).needsPlan).toBe(true);
  });

  it('leaves other tasks alone, also when the ticket says it is not UI work', () => {
    expect(applyUiWorkPlanning(base, undefined)).toBe(base);
    const notUi = { ...base, uiWork: true };
    expect(applyUiWorkPlanning(notUi, false)).toBe(notUi);
  });
});

describe('design model', () => {
  it('is Opus on Claude Code', () => {
    expect(designModelFor('claude', { design: 'x/y' })).toBe(DESIGN_MODEL);
    expect(DESIGN_MODEL).toBe('opus');
  });

  it('on OMP follows the design role, or the plan role when there is no design role, else the Large size', () => {
    expect(designModelFor('omp', { design: 'a/b', plan: 'c/d' })).toBe(OMP_DESIGN_MODEL);
    expect(designModelFor('omp', { plan: 'c/d' })).toBe(OMP_DESIGN_MODEL);
    expect(designModelFor('omp', { default: 'e/f' })).toBe('opus');
    expect(designModelFor('omp', undefined)).toBe('opus');
  });
});

describe('design role resolution', () => {
  const settings = { ...DEFAULT_OMP_BACKEND_SETTINGS, models: { opus: 'lmstudio/big' } };

  it('has a role of its own', () => {
    expect(ompRoleForJob('design')).toBe('design');
  });

  it('uses @design when defined, falls back to @plan, then @default', () => {
    expect(ompRoleSelector('design', { design: 'a/b', plan: 'c/d', default: 'e/f' })).toBe('@design');
    expect(ompRoleSelector('design', { plan: 'c/d', default: 'e/f' })).toBe('@plan');
    expect(ompRoleSelector('design', { default: 'e/f' })).toBe('@default');
    expect(ompRoleSelector('design', undefined)).toBeUndefined();
    expect(ompConfiguredRole('design', { default: 'e/f' })).toBeUndefined();
    expect(ompConfiguredRole('plan', { design: 'a/b' })).toBeUndefined();
  });

  it('the design role beats the Large size mapping; an exact pin still wins', () => {
    const roles = { plan: 'anthropic/opus', default: 'omlx/flash' };
    expect(ompModelFor(OMP_DESIGN_MODEL, settings, 'design', roles)).toBe('@plan');
    expect(ompModelFor('opus', settings, 'design', roles)).toBe('lmstudio/big');
    expect(ompModelFor('omlx/pinned', settings, 'design', roles)).toBe('omlx/pinned');
  });
});

describe('extractDesignSpec', () => {
  it('returns the design spec section, up to the next heading of the same level', () => {
    const plan = '# Plan\n\n## Design spec\n- layout\n- states\n\n## Steps\n1. do it';
    expect(extractDesignSpec(plan)).toBe('## Design spec\n- layout\n- states');
  });

  it('returns the whole plan when there is no design spec heading', () => {
    expect(extractDesignSpec('# Plan\n- a')).toBe('# Plan\n- a');
  });
});
