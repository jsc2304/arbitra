/**
 * @file `<ConnectFlow>` + helpers — structural + pure-helper tests.
 *
 * Per repo convention, the frontend test setup is node-only
 * (`renderToStaticMarkup`). Interactive paths (click → fetch → re-render)
 * are validated by:
 *   - Pure helper assertions: `formatExpiryCountdown`, `isExpired`,
 *     `buildProjectOrder`, `formatClientName`.
 *   - SSR snapshot assertions for the three state branches.
 * End-to-end click flows are deferred to a Playwright suite (out of scope
 * for this PR).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Stub the auth + toast providers so the component renders in isolation.
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({
    user: {
      uid: 'user_1',
      email: 'alex@example.com',
      photoURL: null,
    },
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

// SWR runs lazily — for SSR the fetchers never fire. Stub the api just in case.
vi.mock('../../../lib/api-client', () => ({
  api: {
    auth: { connect: { lookup: vi.fn(), approve: vi.fn(), cancel: vi.fn() } },
    projects: { match: vi.fn(), list: vi.fn(), create: vi.fn() },
  },
}));

// next/navigation needs a stub: router.push is called from CodeInput onSubmit.
const pushSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy }),
}));

import {
  ConnectFlow,
  formatExpiryCountdown,
  isExpired,
} from '../connect-flow';
import { buildProjectOrder, formatClientName } from '../confirm-panel';

describe('formatExpiryCountdown', () => {
  it('formats 9m 42s correctly', () => {
    const expiresAt = new Date(1000 * (9 * 60 + 42)).toISOString();
    expect(formatExpiryCountdown(expiresAt, 0)).toBe('9m 42s');
  });

  it('zero-pads seconds', () => {
    const expiresAt = new Date(1000 * (1 * 60 + 5)).toISOString();
    expect(formatExpiryCountdown(expiresAt, 0)).toBe('1m 05s');
  });

  it('clamps past-deadline to 0m 00s', () => {
    const expiresAt = new Date(0).toISOString();
    expect(formatExpiryCountdown(expiresAt, 10_000)).toBe('0m 00s');
  });
});

describe('isExpired', () => {
  it('returns true when now >= expires_at', () => {
    expect(isExpired(new Date(1_000).toISOString(), 2_000)).toBe(true);
  });
  it('returns true at the exact moment', () => {
    expect(isExpired(new Date(1_000).toISOString(), 1_000)).toBe(true);
  });
  it('returns false when expires_at is in the future', () => {
    expect(isExpired(new Date(2_000).toISOString(), 1_000)).toBe(false);
  });
});

describe('buildProjectOrder', () => {
  const proj = (id: string, name: string) =>
    ({ project_id: id, name, members: [], reviewer_pool: [], tech_leads: [], created_at: '', updated_at: '' } as unknown as import('@arbitra/shared').Project);

  it('lists matches first, then non-matching projects', () => {
    const order = buildProjectOrder(
      [{ project_id: 'p1', project_name: 'arbitra-app', repositories: [] }],
      [proj('p2', 'other-proj'), proj('p1', 'arbitra-app')],
    );
    expect(order.map((o) => o.project_id)).toEqual(['p1', 'p2']);
    expect(order[0]!.matched).toBe(true);
    expect(order[1]!.matched).toBe(false);
  });

  it('returns matches even when not present in allProjects (edge case)', () => {
    const order = buildProjectOrder(
      [{ project_id: 'p1', project_name: 'p1-name', repositories: [] }],
      [],
    );
    expect(order).toHaveLength(1);
  });

  it('deduplicates between matches and allProjects', () => {
    const order = buildProjectOrder(
      [{ project_id: 'p1', project_name: 'p1', repositories: [] }],
      [proj('p1', 'p1')],
    );
    expect(order).toHaveLength(1);
  });

  it('returns an empty array when both inputs are empty', () => {
    expect(buildProjectOrder([], [])).toEqual([]);
  });
});

describe('formatClientName', () => {
  it('uses the friendly lookup for known clients', () => {
    expect(formatClientName('cursor')).toBe('Cursor');
    expect(formatClientName('claude-code')).toBe('Claude Code');
    expect(formatClientName('codex')).toBe('Codex');
    expect(formatClientName('arbitra-mcp-cli')).toBe('Arbitra MCP (CLI)');
  });

  it('title-cases unknown clients', () => {
    expect(formatClientName('some-new-tool')).toBe('Some New Tool');
  });
});

describe('<ConnectFlow /> state branches', () => {
  it('renders the code-input on the no-code branch', () => {
    const html = renderToStaticMarkup(<ConnectFlow initialCode={null} />);
    expect(html).toContain('Enter the code from your tool');
    expect(html).toContain('XXXX-XXXX');
  });

  it('renders the code-input headline copy', () => {
    const html = renderToStaticMarkup(<ConnectFlow initialCode={null} />);
    expect(html).toContain('Connect to Arbitra');
    expect(html).toContain('Paste the one-time code');
  });
});
