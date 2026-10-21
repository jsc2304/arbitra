'use client';

/**
 * `<PreviewBadge>` — badge marking an LLM model catalog entry flagged
 * `preview: true` (see `@arbitra/shared`'s `LlmModel.preview`). Moved out of
 * `settings/ai-models-panel.tsx` (issue #685) so `project/llm-overrides-section.tsx`
 * doesn't need to import a settings-page component for a shared piece of UI.
 */
export function PreviewBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-yellow-50 dark:bg-yellow-900/30 px-2 py-0.5 text-[11px] font-medium text-yellow-700 dark:text-yellow-400">
      Preview — may change or be withdrawn
    </span>
  );
}
