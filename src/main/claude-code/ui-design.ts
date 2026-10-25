/**
 * UI design path
 * ==============
 *
 * A task that involves frontend / UI work (`metadata.uiWork` or triage's `uiWork`) is planned with the
 * design model (OMP role `design`, falling back to `plan`; Opus on Claude Code) and its plan carries a
 * design spec. The project setting `uiImplementer` decides whether the design model also builds it.
 * Validation and the AI review check the result against that spec.
 */

import type { ClaudeModelAlias } from '../../shared/types/claude-code';
import type { AgentBackendKind } from '../../shared/types/agent-backend';
import { ompConfiguredRole, type OmpRoleMap } from '../agent-backend/omp-args';

/** Claude Code's design model */
export const DESIGN_MODEL: ClaudeModelAlias = 'opus';

/** Model name that is not a size alias, so OMP picks the model from the design role instead of the size mapping */
export const OMP_DESIGN_MODEL = 'design';

/**
 * Model a design step runs with when the user did not pin one: Opus on Claude Code; on OMP the design
 * role (or the plan role it falls back to) when the OMP config defines one, else Opus's size.
 */
export function designModelFor(backend: AgentBackendKind, roles: OmpRoleMap | undefined): string {
  if (backend !== 'omp') return DESIGN_MODEL;
  return ompConfiguredRole('design', roles) ? OMP_DESIGN_MODEL : DESIGN_MODEL;
}

/** Added to the plan step's prompt on UI work */
export const DESIGN_SPEC_PROMPT = `

This task involves UI work, so the plan must start with a "## Design spec" section, written before the implementation steps. It defines and designs the UI; the person who builds it follows it. Cover:
- Layout and hierarchy: what is on the screen, how it is arranged, what matters most
- Components: reuse the project's existing components first; name each one and say what new ones are needed and why
- States: loading, empty, error and disabled, plus hover, focus and selected where they apply
- Responsive behaviour: how it changes at narrow and wide widths
- Accessibility: keyboard use and focus order, labels and roles, contrast
- Copy: the exact user-facing text (and its i18n keys when the project uses them)
- Fit with the project's design system: the existing tokens, spacing, typography and patterns to use; read how similar screens are built before deciding
Then give the implementation plan.`;

/** Added to the validation step's prompt on UI work */
export const DESIGN_VALIDATION_PROMPT = `
This is UI work: the plan has a "Design spec" section. Check the result against it (layout and hierarchy, components, states, responsive behaviour, accessibility, copy, design system fit). Treat each deviation from the spec as a finding, and fix the ones that matter.`;

/** Added to the OMP fresh-context review on UI work */
export const DESIGN_REVIEW_PROMPT = `

This is UI work. The plan's design spec is below; a deviation from it is a finding (missing states, wrong components, accessibility gaps, copy or design system mismatches).`;

/** The design spec section of a saved plan, or the whole plan when it has no such heading */
export function extractDesignSpec(plan: string): string {
  const match = /^(#{1,6})\s*design spec\b.*$/im.exec(plan);
  if (!match) return plan;
  const rest = plan.slice(match.index + match[0].length);
  const next = new RegExp(`^#{1,${match[1].length}}\\s`, 'm').exec(rest);
  return `${match[0]}${next ? rest.slice(0, next.index) : rest}`.trim();
}
