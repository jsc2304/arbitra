/**
 * @file activity-leaderboard — right-rail click wiring.
 *
 * Verifies that every clickable surface in Hot Projects + Clients,
 * Attribution Coverage, and Detected Clients renders an interactive
 * <button> when `onFilterClick` is supplied, and degrades to non-
 * interactive markup when omitted.
 *
 * Node-only — mocks SWR + the api client and asserts via
 * `renderToStaticMarkup`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ActivityLeaderboardRow,
  ActivityProjectLeaderboardRow,
} from '@arbitra/shared';

interface LeaderboardResponse {
  rows: ActivityLeaderboardRow[];
  project_rows: ActivityProjectLeaderboardRow[];
}

type SWRState = { data?: LeaderboardResponse; error?: unknown; isLoading: boolean };
const swrState: SWRState = { isLoading: false };

vi.mock('swr', () => ({
  default: () => swrState,
}));

vi.mock('../../../lib/api-client', () => ({
  api: { activity: { leaderboard: vi.fn() } },
}));

import { ActivityLeaderboard } from '../activity-leaderboard';

const projectRow: ActivityProjectLeaderboardRow = {
  project_id: 'acme-atlas',
  project_name: 'Acme Atlas',
  active_cases: 2,
  counts: {
    total: 12,
    cases_created: 4,
    comments: 3,
    evidence: 2,
    findings: 2,
    decisions: 1,
    workspace_events: 0,
  },
} as ActivityProjectLeaderboardRow;

const clientRow: ActivityLeaderboardRow = {
  source_kind: 'client',
  client_name: 'cursor',
  client_version: '0.42',
  model: 'claude-sonnet-4-5',
  counts: {
    total: 5,
    cases_created: 1,
    comments: 2,
    evidence: 0,
    findings: 1,
    decisions: 1,
    workspace_events: 0,
  },
} as ActivityLeaderboardRow;

const fallbackRow: ActivityLeaderboardRow = {
  source_kind: 'human',
  client_name: '',
  counts: {
    total: 3,
    cases_created: 1,
    comments: 1,
    evidence: 0,
    findings: 1,
    decisions: 0,
    workspace_events: 0,
  },
} as ActivityLeaderboardRow;

beforeEach(() => {
  swrState.data = {
    rows: [clientRow, fallbackRow],
    project_rows: [projectRow],
  };
  swrState.error = undefined;
  swrState.isLoading = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ActivityLeaderboard — right-rail wiring', () => {
  it('renders an interactive project label + count button when onFilterClick is wired', () => {
    const html = renderToStaticMarkup(
      <ActivityLeaderboard window="24h" onWindowChange={() => {}} onFilterClick={() => {}} />,
    );
    // Project name is wrapped in a button with the filter title.
    expect(html).toMatch(/<button[^>]*title="Filter feed by project: Acme Atlas"/);
    // Total count carries the filter aria-label.
    expect(html).toMatch(/aria-label="12 actions on Acme Atlas — click to filter feed"/);
  });

  it('degrades the project row to non-interactive markup when onFilterClick is omitted', () => {
    const html = renderToStaticMarkup(
      <ActivityLeaderboard window="24h" onWindowChange={() => {}} />,
    );
    // No project-pin button should be present.
    expect(html).not.toMatch(/title="Filter feed by project:/);
    // No bar segment, attribution fallback, or metric chip rendered as a button.
    expect(html).not.toMatch(/data-testid="leaderboard-bar-segment"/);
    expect(html).not.toMatch(/data-testid="leaderboard-attribution-fallback"/);
    expect(html).not.toMatch(/data-testid="leaderboard-metric-chip"/);
  });

  it('renders bar segments as buttons when onFilterClick is wired', () => {
    const html = renderToStaticMarkup(
      <ActivityLeaderboard window="24h" onWindowChange={() => {}} onFilterClick={() => {}} />,
    );
    // At least one segment button is present (orange / mixed bar callout).
    expect(html).toMatch(/data-testid="leaderboard-bar-segment"/);
  });

  it('renders metric chips as buttons when onFilterClick is wired', () => {
    const html = renderToStaticMarkup(
      <ActivityLeaderboard window="24h" onWindowChange={() => {}} onFilterClick={() => {}} />,
    );
    expect(html).toMatch(/data-testid="leaderboard-metric-chip"/);
  });

  it('renders an interactive attribution fallback button (Raw-mode pin)', () => {
    const html = renderToStaticMarkup(
      <ActivityLeaderboard window="24h" onWindowChange={() => {}} onFilterClick={() => {}} />,
    );
    expect(html).toMatch(/data-testid="leaderboard-attribution-fallback"/);
    expect(html).toMatch(/title="Filter feed to un-attributed actions \(Raw mode\)"/);
  });

  it('renders an interactive client name + count button when onFilterClick is wired', () => {
    const html = renderToStaticMarkup(
      <ActivityLeaderboard window="24h" onWindowChange={() => {}} onFilterClick={() => {}} />,
    );
    // The cursor client row is interactive.
    expect(html).toMatch(/<button[^>]*title="Filter feed by client:/);
  });
});
