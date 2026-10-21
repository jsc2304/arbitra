/**
 * @file CaseTimestamps — case-header Created/Updated row (issue #553).
 *
 * Server-render only (renderToStaticMarkup). Locks the >365-day cleanup:
 *   - Under a year: the canonical two-field "Created <abs> · Updated <rel>"
 *     form (absolute Created + relative Updated companion).
 *   - At/over a year: the redundant "· Updated" form is dropped in favour of a
 *     single unified absolute range "Created <abs> → <abs>" so two full dates
 *     no longer read as "Created May 6, 2026 · Updated May 3, 2025".
 *
 * `now` is implicit (Date.now via isOlderThanOneYear); we drive the branch with
 * timestamps that are unambiguously fresh vs. multi-year-old relative to the
 * test run, so the assertions are stable without faking the clock.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CaseTimestamps } from '../case-header';

const RECENT = new Date(Date.now() - 5 * 60_000).toISOString(); // 5m ago
const TWO_YEARS_AGO = new Date(
  Date.now() - 2 * 365 * 24 * 60 * 60_000,
).toISOString();
const THREE_YEARS_AGO = new Date(
  Date.now() - 3 * 365 * 24 * 60 * 60_000,
).toISOString();

describe('CaseTimestamps — >365d cleanup (#553)', () => {
  it('renders the two-field Created/Updated form when fresh', () => {
    const html = renderToStaticMarkup(
      <CaseTimestamps createdAt={RECENT} updatedAt={RECENT} />,
    );
    expect(html).toContain('Created');
    expect(html).toContain('Updated');
    // Standard separator, not the range arrow.
    expect(html).toContain('·');
    expect(html).not.toContain('→');
  });

  it('collapses to a unified absolute range when updated is >365d old', () => {
    const html = renderToStaticMarkup(
      <CaseTimestamps createdAt={THREE_YEARS_AGO} updatedAt={TWO_YEARS_AGO} />,
    );
    // The redundant "Updated" label and its "·" separator are gone…
    expect(html).not.toContain('Updated');
    expect(html).not.toContain('·');
    // …replaced by a single "Created <abs> → <abs>" range.
    expect(html).toContain('Created');
    expect(html).toContain('→');
    // Both endpoints render as absolute long-form dates (no relative "ago").
    expect(html).not.toMatch(/ago/);
  });

  it('uses the range form even when only updated_at crosses a year', () => {
    // Created recently but updated long ago is non-physical for a real case,
    // but the branch keys solely off updated_at — assert it still collapses.
    const html = renderToStaticMarkup(
      <CaseTimestamps createdAt={RECENT} updatedAt={TWO_YEARS_AGO} />,
    );
    expect(html).toContain('→');
    expect(html).not.toContain('Updated');
  });
});
