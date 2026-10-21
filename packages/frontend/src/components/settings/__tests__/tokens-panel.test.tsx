/**
 * @file `<TokensPanel>` — grouping helpers + render snapshot tests.
 *
 * The grouping behaviour (legacy vs device-grouped, per-tool nesting) is the
 * load-bearing change in PR 2 — locked here via pure-helper tests. Render
 * tests verify the panel surfaces the legacy section, device-revoke CTA, and
 * "Last seen > 60 days" colour cue per spec §F.2.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PersonalAccessToken } from '@arbitra/shared';

// Stub the SWR + provider deps so the component renders top-down in node.
vi.mock('swr', () => ({
  __esModule: true,
  default: (_key: unknown, _fetcher: unknown) => ({
    data: { tokens: testTokens },
    mutate: vi.fn(),
  }),
}));

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock('../../../hooks/use-escape-key', () => ({
  useEscapeKey: () => {},
}));

vi.mock('../../shared/relative-time', () => ({
  RelativeTime: ({ timestamp, prefix, className }: { timestamp: string; prefix?: string; className?: string }) => (
    <span className={className}>{prefix ? `${prefix} ` : ''}{timestamp}</span>
  ),
}));

import {
  TokensPanel,
  groupTokens,
  lastSeenColourClass,
  createdViaBadgeLabel,
} from '../tokens-panel';

const baseToken: PersonalAccessToken = {
  token_id: 'tok_default',
  user_id: 'user_1',
  name: 'default',
  token_hash: 'h',
  token_prefix: 'arb_xxxx...yyyy',
  created_at: new Date('2026-04-01T00:00:00Z').toISOString(),
};

// Used by the SWR mock above. Mutate via tests indirectly: testTokens is fixed
// for the render snapshot tests.
const testTokens: PersonalAccessToken[] = [
  // Legacy token — no client_name, no created_via.
  { ...baseToken, token_id: 'tok_legacy_1', name: 'My old Cursor token' },
  // Device 1, tool A (with last_used > 60d ago — should trip colour cue).
  {
    ...baseToken,
    token_id: 'tok_d1_a',
    name: 'cursor on Alexs-MacBook',
    client_name: 'cursor',
    client_version: '0.42.3',
    device_id: 'd_macbook',
    device_label: 'Alexs-MacBook',
    created_via: 'unified_connect',
    last_used_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  },
  // Device 1, tool B (recent last_used).
  {
    ...baseToken,
    token_id: 'tok_d1_b',
    name: 'claude-code on Alexs-MacBook',
    client_name: 'claude-code',
    device_id: 'd_macbook',
    device_label: 'Alexs-MacBook',
    created_via: 'unified_connect',
    last_used_at: new Date(Date.now() - 60_000).toISOString(),
  },
  // Device 2, CI service token.
  {
    ...baseToken,
    token_id: 'tok_d2',
    name: 'GHA pipeline',
    client_name: 'ci',
    device_id: 'd_ci',
    device_label: 'gha-runner',
    created_via: 'ci_service',
  },
];

describe('groupTokens', () => {
  it('separates legacy tokens from per-device groups', () => {
    const result = groupTokens(testTokens);
    expect(result.legacy).toHaveLength(1);
    expect(result.legacy[0]!.token_id).toBe('tok_legacy_1');
    expect(result.devices).toHaveLength(2);
  });

  it('groups by (device_id, device_label) then by client_name', () => {
    const result = groupTokens(testTokens);
    const macbook = result.devices.find((d) => d.device_id === 'd_macbook')!;
    expect(macbook).toBeTruthy();
    expect(macbook.tools).toHaveLength(2);
    const toolNames = macbook.tools.map((t) => t.client_name).sort();
    expect(toolNames).toEqual(['claude-code', 'cursor']);
  });

  it('places devices with a device_id before label-only fallbacks', () => {
    const mixed: PersonalAccessToken[] = [
      { ...baseToken, token_id: 'a', client_name: 'x', device_label: 'no-id', created_via: 'manual' },
      { ...baseToken, token_id: 'b', client_name: 'x', device_id: 'd', device_label: 'with-id', created_via: 'manual' },
    ];
    const result = groupTokens(mixed);
    expect(result.devices[0]!.device_id).toBe('d');
    expect(result.devices[1]!.device_id).toBeUndefined();
  });

  it('treats a token with only created_via (no client_name) as non-legacy', () => {
    const result = groupTokens([{ ...baseToken, token_id: 'just-via', created_via: 'manual' }]);
    expect(result.legacy).toHaveLength(0);
    expect(result.devices).toHaveLength(1);
  });

  it('treats a token with only client_name (no created_via) as non-legacy', () => {
    const result = groupTokens([{ ...baseToken, token_id: 'just-cn', client_name: 'cursor' }]);
    expect(result.legacy).toHaveLength(0);
  });
});

describe('lastSeenColourClass', () => {
  const now = Date.parse('2026-05-19T12:00:00Z');

  it('returns the muted grey colour for undefined last_used_at', () => {
    expect(lastSeenColourClass(undefined, now)).toContain('text-gray-400');
  });

  it('returns the muted grey colour for recent usage', () => {
    const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    expect(lastSeenColourClass(yesterday, now)).toContain('text-gray-500');
  });

  it('returns the amber stale colour for >60 days idle', () => {
    const seventyDaysAgo = new Date(now - 70 * 24 * 60 * 60 * 1000).toISOString();
    expect(lastSeenColourClass(seventyDaysAgo, now)).toContain('text-amber-600');
  });

  it('handles the 60-day boundary as not-yet-stale', () => {
    const exactlySixty = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(lastSeenColourClass(exactlySixty, now)).toContain('text-gray-500');
  });

  it('gracefully handles a malformed ISO string', () => {
    expect(lastSeenColourClass('not-a-date', now)).toContain('text-gray-400');
  });
});

describe('createdViaBadgeLabel', () => {
  it('maps each created_via value to a human label', () => {
    expect(createdViaBadgeLabel({ ...baseToken, created_via: 'unified_connect' })).toBe('Connect flow');
    expect(createdViaBadgeLabel({ ...baseToken, created_via: 'ci_service' })).toBe('CI');
    expect(createdViaBadgeLabel({ ...baseToken, created_via: 'manual' })).toBe('Manual');
    expect(createdViaBadgeLabel({ ...baseToken })).toBe('Manual');
  });
});

describe('<TokensPanel /> structure', () => {
  it('renders the "Connections" header and Legacy section', () => {
    const html = renderToStaticMarkup(<TokensPanel />);
    expect(html).toContain('Connections');
    expect(html).toContain('Legacy tokens');
    expect(html).toContain('My old Cursor token');
    expect(html).toContain('Replace');
  });

  it('renders device-grouped sections with the bulk-revoke CTA', () => {
    const html = renderToStaticMarkup(<TokensPanel />);
    expect(html).toContain('Alexs-MacBook');
    expect(html).toContain('gha-runner');
    expect(html).toContain('Revoke all on this device');
  });

  it('shows the Connect flow / CI badges per token', () => {
    const html = renderToStaticMarkup(<TokensPanel />);
    expect(html).toContain('Connect flow');
    expect(html).toContain('CI');
  });

  it('renders the amber stale colour class for tokens >60d idle', () => {
    const html = renderToStaticMarkup(<TokensPanel />);
    expect(html).toContain('text-amber-600');
  });

  it('does NOT render a primary "Generate Token" button (spec §F.2)', () => {
    const html = renderToStaticMarkup(<TokensPanel />);
    expect(html).not.toContain('Generate Token');
  });

  it('renders the Advanced disclosure with the CI service token CTA', () => {
    const html = renderToStaticMarkup(<TokensPanel />);
    expect(html).toContain('Advanced');
    // The CTA only renders after the toggle is opened — verify the toggle
    // button is present.
    expect(html).toContain('aria-expanded');
  });
});
