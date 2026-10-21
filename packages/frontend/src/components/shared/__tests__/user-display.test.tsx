/**
 * Static-markup tests for UserDisplay's fallback branches. The frontend test
 * setup is node-only (no jsdom) so we render via `renderToStaticMarkup` and
 * assert on the resulting HTML — same pattern as side-drawer.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { User } from '@arbitra/shared';
import { UserDisplay } from '../user-display';

const ALICE: User = {
  user_id: 'alice-id',
  email: 'alice@example.com',
  display_name: 'Alice',
} as User;

describe('UserDisplay fallback branches', () => {
  it('renders the resolved display name when the user is present in the map', () => {
    const html = renderToStaticMarkup(
      <UserDisplay userId="alice-id" users={{ 'alice-id': ALICE }} />,
    );
    expect(html).toContain('Alice');
    expect(html).not.toContain('Unknown user');
  });

  it('renders the UnknownUser pill (not the raw id) when the user-map is empty for a human id', () => {
    const html = renderToStaticMarkup(
      <UserDisplay userId="WvEOTfY8xABCDEFGHIJ" users={{}} />,
    );
    expect(html).toContain('data-testid="unknown-user-pill"');
    expect(html).toContain('Unknown user');
    // Raw id is preserved on hover only — must not appear as visible text.
    expect(html).not.toContain('>WvEOTfY8x');
    expect(html).not.toContain('WvEOTfY8x...');
    // But MUST be reachable via the title tooltip for support / debug.
    expect(html).toContain('title="WvEOTfY8xABCDEFGHIJ"');
  });

  it('renders the SystemActor pill for the bare "system" actor', () => {
    const html = renderToStaticMarkup(
      <UserDisplay userId="system" users={{}} />,
    );
    expect(html).toContain('data-testid="system-actor-pill"');
    expect(html).toContain('data-kind="system"');
    expect(html).toContain('System');
  });

  it('classifies system:arbitra-webhook as a Webhook pill', () => {
    const html = renderToStaticMarkup(
      <UserDisplay userId="system:arbitra-webhook" users={{}} />,
    );
    expect(html).toContain('data-kind="webhook"');
    expect(html).toContain('Webhook');
    expect(html).not.toContain('>system:arbitra-webhook<');
  });

  it('classifies system:arbitra-intelligence as a Code Intelligence pill', () => {
    const html = renderToStaticMarkup(
      <UserDisplay userId="system:arbitra-intelligence" users={{}} />,
    );
    expect(html).toContain('data-kind="intelligence"');
    expect(html).toContain('Code Intelligence');
  });

  it('classifies an unknown system:* suffix as the generic Arbitra agent pill', () => {
    const html = renderToStaticMarkup(
      <UserDisplay userId="system:some-future-actor" users={{}} />,
    );
    expect(html).toContain('data-kind="agent"');
    expect(html).toContain('Arbitra agent');
    // Raw suffix only shows in the title attribute, not as visible text.
    expect(html).not.toContain('>system:some-future-actor<');
    expect(html).toContain('system:some-future-actor');
  });
});
