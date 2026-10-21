import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, CaseEvent, CustomerReportContent } from '@arbitra/shared';

// ---------------------------------------------------------------------------
// Mocks for the LLM dependencies — wired before importing the module.
// ---------------------------------------------------------------------------

vi.mock('ai', () => ({
  generateObject: vi.fn(),
}));

vi.mock('../../lib/llm-provider.js', () => ({
  resolveModelForRiskWithProject: vi.fn().mockResolvedValue({ modelId: 'mock-model' }),
}));

import { generateObject } from 'ai';
import {
  buildCustomerReportContent,
  extractChangedFiles,
  findTerminalEventAt,
  renderCustomerReportHtml,
  renderCustomerReportMarkdown,
  PARTIAL_FILE_LIST_NOTE,
} from './customer-report-renderer.js';

const mockGenerateObject = vi.mocked(generateObject);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_sunny_coast_abc1',
    title: 'Fix checkout rounding error',
    description: 'Customers saw incorrect totals when ordering more than 5 items.',
    status: 'done',
    risk_level: 'medium',
    priority: 'medium',
    case_type: 'bugfix',
    validation_track: 'direct',
    owner_user_id: 'user_1',
    project_id: 'proj_1',
    repository_id: 'owner/repo',
    current_branch: 'fix/checkout-rounding',
    current_pr_ref: 'https://github.com/owner/repo/pull/42',
    created_at: '2026-04-10T10:00:00Z',
    updated_at: '2026-04-15T16:00:00Z',
    decision_ready: true,
    ...overrides,
  } as Case;
}

function makeEvent(type: string, created_at: string): CaseEvent {
  return {
    event_id: `evt_${type}_${created_at}`,
    case_id: 'case_sunny_coast_abc1',
    type: type as CaseEvent['type'],
    actor_id: 'system',
    payload: {},
    created_at,
  };
}

// ---------------------------------------------------------------------------
// extractChangedFiles
// ---------------------------------------------------------------------------

describe('extractChangedFiles', () => {
  it('parses file paths from a unified diff', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 1111..2222 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      '-old',
      '+new',
      'diff --git a/src/bar.ts b/src/bar.ts',
      '--- a/src/bar.ts',
      '+++ b/src/bar.ts',
    ].join('\n');
    expect(extractChangedFiles(diff)).toEqual(['src/bar.ts', 'src/foo.ts']);
  });

  it('returns empty for empty diff', () => {
    expect(extractChangedFiles('')).toEqual([]);
  });

  it('deduplicates and sorts', () => {
    const diff = [
      'diff --git a/b.ts b/b.ts',
      'diff --git a/a.ts b/a.ts',
      '+++ b/a.ts',
    ].join('\n');
    expect(extractChangedFiles(diff)).toEqual(['a.ts', 'b.ts']);
  });
});

// ---------------------------------------------------------------------------
// findTerminalEventAt
// ---------------------------------------------------------------------------

describe('findTerminalEventAt', () => {
  it('prefers case_completed over other events', () => {
    const events = [
      makeEvent('case_approved', '2026-04-14T10:00:00Z'),
      makeEvent('pr_merged', '2026-04-15T09:00:00Z'),
      makeEvent('case_completed', '2026-04-15T12:00:00Z'),
    ];
    expect(findTerminalEventAt(events)).toBe('2026-04-15T12:00:00Z');
  });

  it('falls back to pr_merged, then case_approved', () => {
    expect(
      findTerminalEventAt([makeEvent('case_approved', '2026-04-14T10:00:00Z')]),
    ).toBe('2026-04-14T10:00:00Z');
  });

  it('returns null when no terminal event', () => {
    expect(findTerminalEventAt([makeEvent('case_created', '2026-04-10T10:00:00Z')])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildCustomerReportContent — happy path
// ---------------------------------------------------------------------------

describe('buildCustomerReportContent', () => {
  beforeEach(() => {
    mockGenerateObject.mockReset();
  });

  it('returns LLM-derived summary + deterministic parts on success', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: 'We fixed the checkout totals so customers see correct prices for large orders.',
        outcome_line: 'Delivered and merged on 2026-04-15.',
        manual_test_steps: [],
      },
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    } as unknown as Awaited<ReturnType<typeof generateObject>>);

    const content = await buildCustomerReportContent({
      case: makeCase(),
      events: [makeEvent('case_completed', '2026-04-15T12:00:00Z')],
      changedFiles: ['src/checkout/total.ts', 'src/checkout/total.test.ts'],
      repositoryName: 'owner/repo',
      terminalEventAt: '2026-04-15T12:00:00Z',
      manualTrack: false,
    });

    expect(content.summary).toContain('checkout');
    expect(content.outcome_line).toContain('2026-04-15');
    expect(content.completion_date).toBe('2026-04-15');
    expect(content.changed_files).toEqual(['src/checkout/total.ts', 'src/checkout/total.test.ts']);
    expect(content.reference.pr_url).toBe('https://github.com/owner/repo/pull/42');
    expect(content.manual_test_steps).toEqual([]);
    // Happy path must return the LLM summary unchanged, not the description.
    expect(content.summary).toBe(
      'We fixed the checkout totals so customers see correct prices for large orders.',
    );
  });

  it('carries the truncation flag into the report content (#877)', async () => {
    mockGenerateObject.mockResolvedValue({
      object: { summary: 'We shipped a large update.', outcome_line: 'Delivered.', manual_test_steps: [] },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as unknown as Awaited<ReturnType<typeof generateObject>>);

    const truncated = await buildCustomerReportContent({
      case: makeCase(),
      events: [],
      changedFiles: ['src/a.ts'],
      changedFilesTruncated: true,
      repositoryName: 'owner/repo',
      terminalEventAt: null,
      manualTrack: false,
    });
    expect(truncated.changed_files_truncated).toBe(true);

    const complete = await buildCustomerReportContent({
      case: makeCase(),
      events: [],
      changedFiles: ['src/a.ts'],
      repositoryName: 'owner/repo',
      terminalEventAt: null,
      manualTrack: false,
    });
    expect(complete.changed_files_truncated).toBe(false);
  });

  it('falls back to case.description on LLM failure when description is non-empty', async () => {
    mockGenerateObject.mockRejectedValue(new Error('model unavailable'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const content = await buildCustomerReportContent({
      case: makeCase({
        description: 'Customers saw incorrect totals when ordering more than 5 items.',
      }),
      events: [],
      changedFiles: ['src/a.ts'],
      repositoryName: 'owner/repo',
      terminalEventAt: '2026-04-15T12:00:00Z',
      manualTrack: false,
    });

    expect(content.summary).toBe(
      'Customers saw incorrect totals when ordering more than 5 items.',
    );
    // The old placeholder must never appear under any fallback path.
    expect(content.summary).not.toContain('Summary generation unavailable');
    expect(content.outcome_line).toBe('Completed on 2026-04-15.');
    expect(content.changed_files).toEqual(['src/a.ts']);
    expect(content.reference.pr_url).toBe('https://github.com/owner/repo/pull/42');

    errSpy.mockRestore();
  });

  it('falls back to deterministic outcome line on LLM failure when description is empty/whitespace', async () => {
    mockGenerateObject.mockRejectedValue(new Error('model unavailable'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const content = await buildCustomerReportContent({
      case: makeCase({ description: '   \n\t  ' }),
      events: [],
      changedFiles: [],
      repositoryName: null,
      terminalEventAt: '2026-04-15T12:00:00Z',
      manualTrack: false,
    });

    expect(content.summary).toBe('Completed on 2026-04-15.');
    expect(content.summary).not.toContain('Summary generation unavailable');
    expect(content.outcome_line).toBe('Completed on 2026-04-15.');

    errSpy.mockRestore();
  });

  it('uses "Completed." when both description and terminalEventAt are absent', async () => {
    mockGenerateObject.mockRejectedValue(new Error('model unavailable'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const content = await buildCustomerReportContent({
      case: makeCase({ description: '' }),
      events: [],
      changedFiles: [],
      repositoryName: null,
      terminalEventAt: null,
      manualTrack: false,
    });

    expect(content.summary).toBe('Completed.');
    expect(content.outcome_line).toBe('Completed.');

    errSpy.mockRestore();
  });

  it('suppresses manual_test_steps on the direct track even if the LLM returns some', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: 'A short business summary.',
        outcome_line: 'Delivered on 2026-04-15.',
        manual_test_steps: ['Log in', 'Add item to cart'],
      },
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
    } as unknown as Awaited<ReturnType<typeof generateObject>>);

    const content = await buildCustomerReportContent({
      case: makeCase({ validation_track: 'direct' }),
      events: [],
      changedFiles: [],
      repositoryName: null,
      terminalEventAt: null,
      manualTrack: false,
    });

    expect(content.manual_test_steps).toEqual([]);
  });

  it('falls back to case.description when LLM output contains forbidden vocabulary', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: 'We delivered a new finding flow that resolves the totals issue.',
        outcome_line: 'Delivered on 2026-04-15.',
        manual_test_steps: [],
      },
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
    } as unknown as Awaited<ReturnType<typeof generateObject>>);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const content = await buildCustomerReportContent({
      case: makeCase({
        description: 'Customers saw incorrect totals when ordering more than 5 items.',
      }),
      events: [],
      changedFiles: [],
      repositoryName: null,
      terminalEventAt: '2026-04-15T12:00:00Z',
      manualTrack: false,
    });

    expect(content.summary).toBe(
      'Customers saw incorrect totals when ordering more than 5 items.',
    );
    expect(content.summary).not.toContain('Summary generation unavailable');
    expect(content.summary.toLowerCase()).not.toMatch(/\bfinding\b/);
    // Observability: the LLM-failure log must still fire.
    expect(warnSpy).toHaveBeenCalledWith(
      '[customer-report] LLM output contained forbidden vocabulary, using fallback',
    );

    warnSpy.mockRestore();
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function sampleContent(overrides: Partial<CustomerReportContent> = {}): CustomerReportContent {
  return {
    title: 'Fix checkout rounding error',
    reference_id: 'case_sunny_coast_abc1',
    completion_date: '2026-04-15',
    outcome_line: 'Delivered and merged on 2026-04-15.',
    summary: 'We corrected totals on large orders so customers see the right price.',
    changed_files: ['src/checkout/total.ts', 'src/checkout/total.test.ts'],
    manual_test_steps: [],
    reference: {
      pr_url: 'https://github.com/owner/repo/pull/42',
      branch: 'fix/checkout-rounding',
      repository: 'owner/repo',
    },
    ...overrides,
  };
}

describe('renderCustomerReportMarkdown', () => {
  it('renders the expected sections', () => {
    const md = renderCustomerReportMarkdown(sampleContent());
    expect(md).toMatch(/^# Fix checkout rounding error/);
    expect(md).toContain('## Summary');
    expect(md).toContain('## Outcome');
    expect(md).toContain('## Changed Files');
    expect(md).toContain('## Reference');
    expect(md).toContain('src/checkout/total.ts');
    expect(md).toContain('https://github.com/owner/repo/pull/42');
    expect(md).toContain('Delivered and merged on 2026-04-15.');
  });

  it('omits the Manual Verification Steps section when empty', () => {
    const md = renderCustomerReportMarkdown(sampleContent({ manual_test_steps: [] }));
    expect(md).not.toContain('Manual Verification Steps');
  });

  it('includes Manual Verification Steps when provided', () => {
    const md = renderCustomerReportMarkdown(
      sampleContent({ manual_test_steps: ['Log in as customer', 'Place a large order'] }),
    );
    expect(md).toContain('## Manual Verification Steps');
    expect(md).toContain('Log in as customer');
    expect(md).toContain('Place a large order');
  });

  it('never renders the old "Summary generation unavailable" placeholder or footer', () => {
    const md = renderCustomerReportMarkdown(sampleContent());
    expect(md).not.toContain('Summary generation unavailable');
    expect(md).not.toContain('deterministic parts');
  });

  // ---- Leakage guard: prose fields must not contain forbidden vocab -----
  //
  // Scope: this guard only covers the generated prose (summary,
  // outcome_line, manual_test_steps). File paths in "Changed Files" are
  // exempt (see the sibling test below).
  it('does not leak internal vocabulary in generated prose (summary / outcome / steps)', () => {
    const content = sampleContent({
      manual_test_steps: ['Log in as a customer', 'Place a large order'],
    });
    const prose = [
      content.summary,
      content.outcome_line,
      ...content.manual_test_steps,
    ].join(' ');

    const forbidden = [
      'finding',
      'evidence',
      'decision',
      'four-eyes',
      'waive',
      'waived',
      'validation track',
      'direct track',
      'manual track',
      'reviewer_pool',
      'case_status',
      'state machine',
      'risk_level',
      'rule_override',
      'rule engine',
      'rule set',
      'review_run',
      'build run',
      'review run',
    ];
    for (const word of forbidden) {
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      expect(re.test(prose), `prose leaked the word "${word}"`).toBe(false);
    }
  });

  // File paths are legitimate technical artifacts and are exempt from the
  // forbidden-vocabulary guard. Arbitra's own code lives under paths like
  // `packages/backend/src/services/evidence/…` — a customer reading a file
  // list must see the real paths.
  it('allows forbidden words inside Changed Files paths (exempt from leak guard)', () => {
    const md = renderCustomerReportMarkdown(
      sampleContent({
        changed_files: [
          'packages/backend/src/services/evidence/registrar.ts',
          'packages/backend/src/services/rule-engine/evaluator.ts',
          'packages/backend/src/services/decision/recorder.ts',
        ],
      }),
    );
    expect(md).toContain('packages/backend/src/services/evidence/registrar.ts');
    expect(md).toContain('rule-engine/evaluator.ts');
    expect(md).toContain('decision/recorder.ts');
  });

  // #877: the file list is derived from the diff, and a truncated diff only
  // names the files inside the prefix. Rendering that as a complete list
  // understates the scope of the change to the customer.
  it('states that the file list is partial when the diff was truncated', () => {
    const md = renderCustomerReportMarkdown(sampleContent({ changed_files_truncated: true }));
    expect(md).toContain(PARTIAL_FILE_LIST_NOTE);
  });

  it('omits the partial-list note for a complete diff', () => {
    expect(renderCustomerReportMarkdown(sampleContent())).not.toContain(PARTIAL_FILE_LIST_NOTE);
    expect(
      renderCustomerReportMarkdown(sampleContent({ changed_files_truncated: false })),
    ).not.toContain(PARTIAL_FILE_LIST_NOTE);
  });
});

describe('renderCustomerReportHtml', () => {
  it('renders a standalone HTML document with inline CSS', () => {
    const html = renderCustomerReportHtml(sampleContent());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>Fix checkout rounding error</title>');
    expect(html).toContain('<style>');
    expect(html).toContain('src/checkout/total.ts');
    expect(html).toContain('https://github.com/owner/repo/pull/42');
  });

  it('escapes HTML-sensitive characters in title/summary', () => {
    const html = renderCustomerReportHtml(
      sampleContent({ title: 'Fix <script>alert(1)</script>', summary: 'A & B' }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B');
  });

  it('omits the Manual Verification Steps section when empty', () => {
    const html = renderCustomerReportHtml(sampleContent({ manual_test_steps: [] }));
    expect(html).not.toContain('Manual Verification Steps');
  });

  it('does not leak internal vocabulary in generated prose (summary / outcome / steps)', () => {
    const content = sampleContent({
      manual_test_steps: ['Log in as a customer', 'Place a large order'],
    });
    const prose = [
      content.summary,
      content.outcome_line,
      ...content.manual_test_steps,
    ].join(' ');
    const forbidden = [
      'finding',
      'evidence',
      'decision',
      'four-eyes',
      'waive',
      'validation track',
      'reviewer_pool',
      'case_status',
      'state machine',
      'risk_level',
      'rule_override',
      'rule engine',
    ];
    for (const word of forbidden) {
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      expect(re.test(prose), `prose leaked the word "${word}"`).toBe(false);
    }
  });

  // See the Markdown renderer tests — file paths are exempt.
  it('allows forbidden words inside Changed Files paths (exempt from leak guard)', () => {
    const html = renderCustomerReportHtml(
      sampleContent({
        changed_files: [
          'packages/backend/src/services/evidence/registrar.ts',
          'packages/backend/src/services/rule-engine/evaluator.ts',
        ],
      }),
    );
    expect(html).toContain('evidence/registrar.ts');
    expect(html).toContain('rule-engine/evaluator.ts');
  });

  it('does not emit a javascript: href (XSS guard on pr_url)', () => {
    const html = renderCustomerReportHtml(
      sampleContent({
        reference: {
          pr_url: 'javascript:alert(1)',
          branch: 'fix/checkout-rounding',
          repository: 'owner/repo',
        },
      }),
    );
    expect(html).not.toMatch(/href="javascript:/i);
    // The value is still shown as plain text (escaped), so the reference
    // section is not silently dropped.
    expect(html).toContain('javascript:alert(1)');
  });

  it('does not link pr_url with non-http schemes (data:, file:)', () => {
    for (const bad of ['data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'not-a-url']) {
      const html = renderCustomerReportHtml(
        sampleContent({
          reference: { pr_url: bad, branch: null, repository: null },
        }),
      );
      expect(html).not.toMatch(/<a href=/i);
    }
  });

  it('still renders an anchor for valid https pr_url', () => {
    const html = renderCustomerReportHtml(sampleContent());
    expect(html).toMatch(/<a href="https:\/\/github\.com\/owner\/repo\/pull\/42">/);
  });

  it('never renders the old "Summary generation unavailable" notice', () => {
    const html = renderCustomerReportHtml(sampleContent());
    expect(html).not.toContain('Summary generation unavailable');
    expect(html).not.toContain('deterministic parts');
    expect(html).not.toContain('class="notice"');
  });

  // When the LLM path is unusable, the fallback chain uses case.description
  // verbatim. Descriptions are user-authored markdown — headings, bold,
  // bullet lists, code fences. The HTML export must render those as HTML so
  // customers do not see raw `##` / `**` / `-` characters as literal text.
  it('renders markdown in the summary field as HTML (description-fallback path)', () => {
    const html = renderCustomerReportHtml(
      sampleContent({
        summary: '## Heading\n\n**Bold text**\n\n- item 1\n- item 2',
      }),
    );
    expect(html).toContain('<h2>Heading</h2>');
    expect(html).toContain('<strong>Bold text</strong>');
    expect(html).toMatch(/<ul>\s*<li>item 1<\/li>\s*<li>item 2<\/li>\s*<\/ul>/);
    // Raw markdown syntax must not survive as literal text.
    expect(html).not.toMatch(/^\s*##\s/m);
    expect(html).not.toContain('**Bold text**');
    // The bullet list in the summary must not bleed a raw `- item` line.
    expect(html).not.toMatch(/^- item 1$/m);
  });

  // sanitize-html must strip dangerous tags from user-authored markdown.
  // Text content may survive (escaped) — that is acceptable; what matters
  // is that no executable <script> tag reaches the DOM.
  it('strips <script> from markdown summary (XSS guard via sanitize-html)', () => {
    const html = renderCustomerReportHtml(
      sampleContent({
        summary: 'Intro paragraph.\n\n<script>alert(1)</script>\n\nAfter.',
      }),
    );
    // No executable script tag in the rendered output — anywhere.
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<\/script>/i);
    // Regular prose around the injected tag still renders.
    expect(html).toContain('Intro paragraph.');
    expect(html).toContain('After.');
  });
});
