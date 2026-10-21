/**
 * @file knowledge-capture-prompt — unit tests for the Courtroom "Suggest
 * Knowledge Asset" form.
 *
 * Node-only per the frontend convention (see rationale-form.test.tsx).
 * `renderToStaticMarkup` only renders the initial ('prompt') state, so we
 * exercise the form state by driving the component through its state prop
 * indirectly is not possible; instead we assert the fields/contract that the
 * form promises once opened, plus the initial prompt shape.
 *
 * Regression coverage for #702: the form must collect a dedicated `body`
 * field (min 50) alongside `summary` (min 10) so submission can satisfy the
 * create-knowledge-asset API contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { KnowledgeCapturePrompt } from '../knowledge-capture-prompt';

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ addToast: () => {} }),
}));

vi.mock('../../../lib/api-client', () => ({
  api: { knowledge: { create: async () => ({}) } },
}));

function render(): string {
  return renderToStaticMarkup(
    <KnowledgeCapturePrompt
      caseId="case-1"
      caseTitle="Example case"
      projectId="proj-1"
      decisionId="dec-1"
      decisionType="approve"
      rationale="This rationale is long enough to be a summary."
      onClose={() => {}}
    />,
  );
}

describe('<KnowledgeCapturePrompt /> — initial prompt', () => {
  it('renders the "Save as Knowledge" call-to-action', () => {
    const html = render();
    expect(html).toContain('Save this decision as a knowledge asset?');
    expect(html).toContain('Save as Knowledge');
  });
});

describe('form field contract (source-level guarantees for #702)', () => {
  // Read the component source so the test fails if the body field or the
  // min-length contract regresses, without needing to drive React state.
  const source = () =>
    readFileSync(join(__dirname, '..', 'knowledge-capture-prompt.tsx'), 'utf8');

  it('exposes a dedicated body textarea submitted as `body`', () => {
    const src = source();
    expect(src).toContain('id="ka-body"');
    // body must be trimmed and sent (not hardcoded to an empty string).
    expect(src).toContain('body: trimmedBody');
    expect(src).not.toContain("body: ''");
  });

  it('keeps summary as the short field and mirrors the API min-lengths', () => {
    const src = source();
    expect(src).toContain('SUMMARY_MIN = 10');
    expect(src).toContain('BODY_MIN = 50');
    expect(src).toContain('id="ka-summary"');
  });

  it('gates submission on both summary and body validity', () => {
    const src = source();
    expect(src).toContain('const canSubmit =');
    expect(src).toContain('summaryValid');
    expect(src).toContain('bodyValid');
    expect(src).toContain('disabled={submitting || !canSubmit}');
  });
});
