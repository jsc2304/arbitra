/**
 * @file `/clerk` tab bar — which panel renders for a given `?tab=`, and that
 * Ask stays the default once Context and Scheduled exist (#832 slice 1,
 * #793 slice B3).
 *
 * Node-only per the frontend convention (renderToStaticMarkup, no jsdom, no
 * `fireEvent`) — `ClerkAskPanel`/`ClerkContextPanel`/`ClerkScheduledPanel`
 * are mocked to distinct marker strings so this suite asserts the PAGE's
 * tab-selection wiring, not any panel's own internals (those have their own
 * test files).
 *
 * `resolveClerkTab`/`CLERK_TABS` are imported from `lib/clerk-tabs`, not
 * from `./page`: a Next.js App Router page file may only export the
 * whitelisted page fields (`default`, `metadata`, …), so the tab helpers
 * live in their own module (see that file's header comment) and `page.tsx`
 * re-exports nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CLERK_TABS, resolveClerkTab } from '../../lib/clerk-tabs';
import ClerkPage from './page';

let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
}));

vi.mock('../../components/clerk/clerk-ask-panel', () => ({
  ClerkAskPanel: () => <div data-testid="ask-panel-marker">ASK_PANEL</div>,
}));

vi.mock('../../components/clerk/clerk-context-panel', () => ({
  ClerkContextPanel: () => <div data-testid="context-panel-marker">CONTEXT_PANEL</div>,
}));

vi.mock('../../components/clerk/clerk-scheduled-panel', () => ({
  ClerkScheduledPanel: () => <div data-testid="scheduled-panel-marker">SCHEDULED_PANEL</div>,
}));

describe('CLERK_TABS', () => {
  it('lists Ask, Context, and Scheduled, in that order', () => {
    // The Scheduled entry (#793 slice B3) is the one-entry addition the
    // array's own doc comment anticipated — this test is the regression
    // guard for that addition landing as a rewrite instead.
    expect(CLERK_TABS).toEqual([
      { key: 'ask', label: 'Ask' },
      { key: 'context', label: 'Context' },
      { key: 'scheduled', label: 'Scheduled' },
    ]);
  });
});

describe('resolveClerkTab', () => {
  it('defaults to ask when no tab is named', () => {
    expect(resolveClerkTab(null)).toBe('ask');
  });

  it('defaults to ask for an unknown or mistyped tab', () => {
    expect(resolveClerkTab('Scheduled')).toBe('ask');
    expect(resolveClerkTab('Context')).toBe('ask');
    expect(resolveClerkTab('')).toBe('ask');
  });

  it('honours every valid tab param, including scheduled', () => {
    expect(resolveClerkTab('context')).toBe('context');
    expect(resolveClerkTab('scheduled')).toBe('scheduled');
  });
});

describe('ClerkPage — tab selection', () => {
  it('renders the Ask panel by default, with Context and Scheduled absent', () => {
    searchParams = new URLSearchParams();

    const html = renderToStaticMarkup(<ClerkPage />);

    expect(html).toContain('ASK_PANEL');
    expect(html).not.toContain('CONTEXT_PANEL');
    expect(html).not.toContain('SCHEDULED_PANEL');
  });

  it('renders the Context panel for ?tab=context, with Ask and Scheduled absent', () => {
    searchParams = new URLSearchParams('tab=context');

    const html = renderToStaticMarkup(<ClerkPage />);

    expect(html).toContain('CONTEXT_PANEL');
    expect(html).not.toContain('ASK_PANEL');
    expect(html).not.toContain('SCHEDULED_PANEL');
  });

  it('renders the Scheduled panel for ?tab=scheduled, with Ask and Context absent', () => {
    searchParams = new URLSearchParams('tab=scheduled');

    const html = renderToStaticMarkup(<ClerkPage />);

    expect(html).toContain('SCHEDULED_PANEL');
    expect(html).not.toContain('ASK_PANEL');
    expect(html).not.toContain('CONTEXT_PANEL');
  });

  it('falls back to Ask for an unrecognised ?tab= value', () => {
    searchParams = new URLSearchParams('tab=bogus');

    const html = renderToStaticMarkup(<ClerkPage />);

    expect(html).toContain('ASK_PANEL');
    expect(html).not.toContain('CONTEXT_PANEL');
    expect(html).not.toContain('SCHEDULED_PANEL');
  });

  it('renders all three tab buttons, with the active one underlined in accent', () => {
    searchParams = new URLSearchParams('tab=scheduled');

    const html = renderToStaticMarkup(<ClerkPage />);

    expect(html).toContain('>Ask<');
    expect(html).toContain('>Context<');
    expect(html).toContain('>Scheduled<');
    // The active tab's button carries the accent underline; an inactive one
    // carries the neutral, transparent-border classes instead.
    const scheduledButton = html.slice(html.lastIndexOf('<button', html.indexOf('>Scheduled<')));
    expect(scheduledButton).toContain('border-accent');
    const askButton = html.slice(
      html.lastIndexOf('<button', html.indexOf('>Ask<')),
      html.indexOf('>Ask<'),
    );
    expect(askButton).toContain('border-transparent');
  });
});
