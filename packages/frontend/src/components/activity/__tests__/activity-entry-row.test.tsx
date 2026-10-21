/**
 * @file activity-entry-row — callback wiring tests.
 *
 * Verifies that workspace-event rows render a clickable <button> when an
 * `onWorkspaceEventClick` handler is passed, and stay plain / link-based
 * otherwise. Interaction tests (actually firing the click and asserting the
 * callback ran) require a DOM environment; the frontend test setup is
 * node-only by design, so we assert via static markup introspection.
 *
 * The button presence + wired title + role is enough to catch the class of
 * regressions that matter for PR 1: "did we actually turn the summary into a
 * button for workspace-event rows?".
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityEntry } from '@arbitra/shared';
import { ActivityEntryRow } from '../activity-entry-row';

const baseWorkspaceEvent: ActivityEntry = {
  id: 'workspace_event:evt_1',
  kind: 'workspace_event',
  timestamp: '2026-04-23T12:00:00.000Z',
  case_id: '',
  summary: 'Intelligence run completed',
  href: '',
};

const baseCaseEvent: ActivityEntry = {
  id: 'case_event:evt_2',
  kind: 'case_event',
  timestamp: '2026-04-23T12:00:00.000Z',
  case_id: 'case_abc',
  case_title: 'Refactor auth middleware',
  summary: 'opened case',
  href: '/cases/case_abc',
};

describe('ActivityEntryRow — workspace-event clickability', () => {
  it('renders the summary as a <button> when onWorkspaceEventClick is provided', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={baseWorkspaceEvent}
        onWorkspaceEventClick={() => {}}
      />,
    );
    // Button carries the summary as both visible text and title.
    expect(html).toContain('<button');
    expect(html).toContain('Intelligence run completed');
    // Title attribute confirms the summary is wired into the button, not a
    // sibling node that happens to share the text.
    expect(html).toMatch(
      /<button[^>]*title="Intelligence run completed"[^>]*>[^<]*Intelligence run completed/,
    );
  });

  it('falls back to a plain <span> when no callback is supplied', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow entry={baseWorkspaceEvent} />,
    );
    // No button wrapping the summary when the consumer hasn't opted in.
    expect(html).not.toMatch(
      /<button[^>]*>[^<]*Intelligence run completed/,
    );
    expect(html).toContain('Intelligence run completed');
  });

  it('does NOT convert case-scoped rows into workspace-event buttons', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={baseCaseEvent}
        onWorkspaceEventClick={() => {
          throw new Error('workspace-event handler fired for case-scoped row');
        }}
      />,
    );
    // The summary for case-scoped rows stays as a span/link on the case title,
    // not as the workspace-event button variant. Ensure no button surrounds
    // the summary text.
    expect(html).not.toMatch(
      /<button[^>]*title="opened case"[^>]*>[^<]*opened case/,
    );
    // Case title link is still present.
    expect(html).toContain('Refactor auth middleware');
  });

  it('renders the actor as the first, bold token of the headline', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={{
          ...baseCaseEvent,
          actor_metadata: { client_name: 'cursor' },
        }}
      />,
    );
    // "Cursor" must appear before "opened case" — and inside a bold/semibold
    // span so the row reads as `{Actor} {verb} {object}`.
    const cursorIdx = html.indexOf('Cursor');
    const verbIdx = html.indexOf('opened case');
    expect(cursorIdx).toBeGreaterThan(-1);
    expect(verbIdx).toBeGreaterThan(-1);
    expect(cursorIdx).toBeLessThan(verbIdx);
    expect(html).toMatch(/<(span|button)[^>]*font-semibold[^>]*>[^<]*Cursor/);
    // No row may begin its headline with the lowercase verb "opened"
    // immediately after the icon — the actor token always precedes it.
    expect(html).not.toMatch(/<div[^>]*flex-wrap[^>]*>\s*<(span|a)[^>]*>opened case/);
  });

  it('routes detector-opened case_created rows to the "Arbitra flagged" branch', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={{
          ...baseCaseEvent,
          subkind: 'case_created',
          actor_user_id: 'system:arbitra-intelligence',
          summary: 'opened',
          case_title: 'Idle for 7d: Missing four-eyes on: Wave 3',
        }}
      />,
    );
    expect(html).toContain('Arbitra');
    expect(html).toContain('flagged');
    expect(html).toContain('Idle for 7d');
    // The "DB-insert" verb "opened" must NOT leak through — detector rows
    // describe what was detected.
    expect(html).not.toMatch(/>\s*opened\s*</);
    // The case title is emphasised (italic) per the spec grammar.
    expect(html).toMatch(/<a[^>]*italic[^>]*>[^<]*Idle for 7d/);
  });

  it('does NOT route webhook-opened cases (actor "system") to the "Arbitra flagged" branch', () => {
    // Webhook case-creation passes plain `'system'` as the actor
    // (see webhook-service.ts ~L634). Only detector-opened cases
    // (`system:arbitra-intelligence`) should render as "flagged"; webhook
    // rows must fall through to the normal "{Actor} opened *{title}*" path.
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={{
          ...baseCaseEvent,
          subkind: 'case_created',
          actor_user_id: 'system',
          summary: 'opened',
          case_title: 'Build failed: pipeline #42',
        }}
      />,
    );
    expect(html).not.toContain('flagged');
    // The normal "opened" verb is rendered for webhook rows.
    expect(html).toMatch(/>\s*opened\s*</);
    expect(html).toContain('Build failed');
  });

  it('does NOT contain the literal "created the case" phrase anywhere', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={{
          ...baseCaseEvent,
          subkind: 'case_created',
          summary: 'opened',
        }}
      />,
    );
    expect(html).not.toContain('created the case');
  });

  it('renders a row-start severity dot derived from the envelope', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={{
          ...baseCaseEvent,
          severity: 'high',
        }}
      />,
    );
    // High severity must render a coloured dot, not the neutral `·`.
    expect(html).toMatch(/data-testid="severity-dot"[^>]*data-severity="high"/);
    expect(html).toMatch(/aria-label="high severity"/);
    expect(html).toMatch(/bg-red-500/);
  });

  it('renders a neutral severity dot for info-level rows', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={{ ...baseCaseEvent, severity: 'info' }}
      />,
    );
    expect(html).toMatch(/data-testid="severity-dot"[^>]*data-severity="info"/);
    // Info rows use the neutral `·` glyph, not a coloured dot.
    expect(html).not.toMatch(/data-testid="severity-dot"[^>]*bg-red-500/);
    expect(html).not.toMatch(/data-testid="severity-dot"[^>]*bg-orange-500/);
  });

  it('shows the first-of-day badge when isFirstOfDay is true', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow entry={baseCaseEvent} isFirstOfDay />,
    );
    expect(html).toMatch(/data-testid="first-of-day-badge"[^>]*>[^<]*new/);
  });

  it('omits the first-of-day badge when not flagged', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow entry={baseCaseEvent} />,
    );
    expect(html).not.toContain('data-testid="first-of-day-badge"');
  });

  it('renders the preview snippet when entry.preview is set', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={{ ...baseCaseEvent, preview: 'Looks good to me — please ship.' }}
      />,
    );
    expect(html).toMatch(
      /data-testid="preview-snippet"[^>]*>[^<]*Looks good to me/,
    );
  });

  it('routes detector-opened cases via envelope.opened_by, NOT the isDetectorActor string match', () => {
    // `actor_user_id: 'user_alex'` does NOT match the legacy
    // `isDetectorActor('system:arbitra-intelligence')` heuristic — so if this
    // row still renders the "flagged" treatment, it must be driven by the
    // authoritative envelope field `opened_by: 'detector'`, proving the
    // envelope-first migration. The string heuristic survives only as a
    // pre-envelope fallback (when `opened_by` is undefined).
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={{
          ...baseCaseEvent,
          subkind: 'case_created',
          actor_user_id: 'user_alex',
          opened_by: 'detector',
          summary: 'opened',
          case_title: 'Idle for 7d: Wave 3',
        }}
      />,
    );
    expect(html).toContain('flagged');
    expect(html).toContain('Idle for 7d');
    // The plain "opened" verb must not leak through on a flagged row.
    expect(html).not.toMatch(/>\s*opened\s*</);
  });

  it('uses isDetectorActor ONLY as a pre-envelope fallback (opened_by undefined)', () => {
    // A pre-envelope detector row (no `opened_by`) still routes via the legacy
    // string heuristic so historical rows keep rendering correctly.
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={{
          ...baseCaseEvent,
          subkind: 'case_created',
          actor_user_id: 'system:arbitra-intelligence',
          // opened_by intentionally omitted (pre-envelope row).
          summary: 'opened',
          case_title: 'Legacy detector case',
        }}
      />,
    );
    expect(html).toContain('flagged');
    expect(html).toContain('Legacy detector case');
  });

  it('does NOT route a non-detector envelope row to the flagged branch even with opened_by=user', () => {
    // Envelope authoritatively says `opened_by: 'user'` — the legacy actor-id
    // heuristic must not override it, so this stays on the normal path.
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={{
          ...baseCaseEvent,
          subkind: 'case_created',
          actor_user_id: 'system:arbitra-intelligence',
          opened_by: 'user',
          summary: 'opened',
          case_title: 'User-opened case',
        }}
      />,
    );
    expect(html).not.toContain('flagged');
    expect(html).toMatch(/>\s*opened\s*</);
  });

  it('renders an actor avatar for the row', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow entry={baseCaseEvent} />,
    );
    expect(html).toMatch(/data-testid="actor-avatar"/);
  });

  it('keeps hover-affordance classes on the workspace-event button', () => {
    const html = renderToStaticMarkup(
      <ActivityEntryRow
        entry={baseWorkspaceEvent}
        onWorkspaceEventClick={() => {}}
      />,
    );
    // Matches the hover background pattern used by other clickable feed rows.
    expect(html).toMatch(/<button[^>]*class="[^"]*hover:bg-/);
  });
});
