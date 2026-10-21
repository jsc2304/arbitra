/**
 * @file `<LlmOverridesSection>` — SSR render-only harness
 * (`renderToStaticMarkup`, no clicks), same pattern as
 * `settings/__tests__/credentials-panel.test.tsx`.
 *
 * Covers #1068: a project with a stored `llm_overrides.provider: 'google'`
 * override must still render once `google` is flipped to `enabled: false`
 * in `LLM_PROVIDERS`, via the existing "legacy provider" fallback option
 * (same mechanism already proven for `openai`).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project } from '@arbitra/shared';

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

import { LlmOverridesSection } from '../llm-overrides-section';

const baseProject: Project = {
  project_id: 'proj_1',
  name: 'Test Project',
  description: '',
  reviewer_pool: [],
  tech_leads: [],
  default_rule_set_refs: [],
  created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
  updated_at: new Date('2026-01-01T00:00:00Z').toISOString(),
};

describe('<LlmOverridesSection /> — stored google override after the #1068 disable', () => {
  it('renders without throwing when the saved override provider is the now-disabled "google"', () => {
    const project: Project = {
      ...baseProject,
      llm_overrides: {
        provider: 'google',
        models: {
          low: 'gemini-2.5-flash-lite',
          high: 'gemini-2.5-pro',
        },
      },
    };

    expect(() =>
      renderToStaticMarkup(<LlmOverridesSection project={project} onUpdate={vi.fn()} />)
    ).not.toThrow();
    const html = renderToStaticMarkup(<LlmOverridesSection project={project} onUpdate={vi.fn()} />);

    // Preserved as a "legacy" option in the provider dropdown rather than
    // silently dropped.
    expect(html).toContain('google (legacy)');
    // The stored risk-level models still resolve to their catalog labels —
    // the catalog (LLM_MODELS) is untouched by the provider-level
    // `enabled: false` flag.
    expect(html).toContain('Gemini 2.5 Flash-Lite');
  });
});
