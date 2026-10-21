/**
 * @file intelligence detector drill-down — rendering tests.
 *
 * Node-only via renderToStaticMarkup (no jsdom). We mock SWR, the api
 * client, next/navigation, and the useIsAdmin hook so each test controls
 * exactly what the page sees.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// ---------------------------------------------------------------------------
// Hoisted shared state — our mocked SWR reads these per call to simulate
// separate SWR keys (admin check, detectors list, findings list).
// ---------------------------------------------------------------------------

type SwrState<T> = { data?: T; error?: unknown; isLoading: boolean };

const { swrByKey, adminState } = vi.hoisted(() => ({
  swrByKey: new Map<string, SwrState<unknown>>(),
  adminState: { isAdmin: true, isLoading: false },
}));

function keyToString(key: unknown): string {
  if (Array.isArray(key)) return key.map(String).join('::');
  if (typeof key === 'string') return key;
  return JSON.stringify(key);
}

vi.mock('swr', () => ({
  default: (key: unknown) => {
    if (key === null) return { data: undefined, error: undefined, isLoading: false };
    const k = keyToString(key);
    return swrByKey.get(k) ?? { data: undefined, error: undefined, isLoading: true };
  },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ detectorId: 'stale-open' }),
}));

vi.mock('../../../../../hooks/use-is-admin', () => ({
  useIsAdmin: () => adminState,
}));

vi.mock('../../../../../lib/api-client', () => ({
  api: {
    intelligence: {
      listDetectors: vi.fn(),
      detectorFindings: vi.fn(),
    },
  },
}));

import IntelligenceDetectorPage from './page';

beforeEach(() => {
  swrByKey.clear();
  adminState.isAdmin = true;
  adminState.isLoading = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IntelligenceDetectorPage', () => {
  it('renders a skeleton while the admin check is still loading', () => {
    adminState.isAdmin = false;
    adminState.isLoading = true;
    const html = renderToStaticMarkup(<IntelligenceDetectorPage />);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('Admin access required');
  });

  it('renders the denial card for a non-admin user once loaded', () => {
    adminState.isAdmin = false;
    adminState.isLoading = false;
    const html = renderToStaticMarkup(<IntelligenceDetectorPage />);
    expect(html).toContain('Admin access required');
  });

  it('renders detector name, thresholds, and findings for an admin', () => {
    swrByKey.set('intelligence-detectors', {
      isLoading: false,
      data: {
        detectors: [
          {
            detector_id: 'stale-open',
            name: 'Stale open cases',
            description: 'Flags open cases with no activity for a while.',
            config: { enabled: true },
          },
        ],
      },
    });
    swrByKey.set('intelligence-detector-findings::stale-open::25', {
      isLoading: false,
      data: {
        findings: [
          {
            case_id: 'case_123',
            title: 'Example stale case',
            status: 'open',
            risk_level: 'medium',
            intelligence_signature: 'stale-open:case_123',
            created_at: '2026-04-20T10:00:00.000Z',
            updated_at: '2026-04-20T10:00:00.000Z',
          },
        ],
      },
    });
    const html = renderToStaticMarkup(<IntelligenceDetectorPage />);
    expect(html).toContain('Stale open cases');
    expect(html).toContain('Flags open cases with no activity');
    // Threshold row (see thresholds.ts — stale-open → 7 days).
    expect(html).toContain('Max days without activity');
    expect(html).toContain('7 days');
    // Finding row + link.
    expect(html).toContain('Example stale case');
    expect(html).toContain('/cases/case_123');
  });

  it('shows an empty-state when there are zero findings', () => {
    swrByKey.set('intelligence-detectors', {
      isLoading: false,
      data: {
        detectors: [
          {
            detector_id: 'stale-open',
            name: 'Stale open cases',
            description: 'desc',
            config: { enabled: true },
          },
        ],
      },
    });
    swrByKey.set('intelligence-detector-findings::stale-open::25', {
      isLoading: false,
      data: { findings: [] },
    });
    const html = renderToStaticMarkup(<IntelligenceDetectorPage />);
    expect(html).toContain('No cases have been attributed to this detector yet.');
  });

  it('renders the full last-run error and a Create index link when a create_composite URL is embedded', () => {
    const indexUrl =
      'https://console.firebase.google.com/project/demo-arbitra/firestore/indexes?create_composite=TOKEN123';
    const errorMessage = `9 FAILED_PRECONDITION: The query requires an index. You can create it here: ${indexUrl}`;
    swrByKey.set('intelligence-detectors', {
      isLoading: false,
      data: {
        detectors: [
          {
            detector_id: 'stale-open',
            name: 'Stale open cases',
            description: 'desc',
            config: { enabled: true },
            last_run: {
              started_at: '2026-07-11T10:00:00.000Z',
              finding_count: 0,
              error: errorMessage,
            },
          },
        ],
      },
    });
    swrByKey.set('intelligence-detector-findings::stale-open::25', {
      isLoading: false,
      data: { findings: [] },
    });
    const html = renderToStaticMarkup(<IntelligenceDetectorPage />);
    expect(html).toContain('Latest run failed');
    // Full message is present (not truncated) — including the URL.
    expect(html).toContain(errorMessage);
    expect(html).toContain(`href="${indexUrl}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Create index');
  });

  it('does not render a last-run error section when the latest run succeeded', () => {
    swrByKey.set('intelligence-detectors', {
      isLoading: false,
      data: {
        detectors: [
          {
            detector_id: 'stale-open',
            name: 'Stale open cases',
            description: 'desc',
            config: { enabled: true },
            last_run: { started_at: '2026-07-11T10:00:00.000Z', finding_count: 2 },
          },
        ],
      },
    });
    swrByKey.set('intelligence-detector-findings::stale-open::25', {
      isLoading: false,
      data: { findings: [] },
    });
    const html = renderToStaticMarkup(<IntelligenceDetectorPage />);
    expect(html).not.toContain('Latest run failed');
    expect(html).not.toContain('Create index');
  });

  it('renders the last-run error without a Create index link when no URL is embedded', () => {
    swrByKey.set('intelligence-detectors', {
      isLoading: false,
      data: {
        detectors: [
          {
            detector_id: 'stale-open',
            name: 'Stale open cases',
            description: 'desc',
            config: { enabled: true },
            last_run: {
              started_at: '2026-07-11T10:00:00.000Z',
              finding_count: 0,
              error: 'permission denied fetching repositories',
            },
          },
        ],
      },
    });
    swrByKey.set('intelligence-detector-findings::stale-open::25', {
      isLoading: false,
      data: { findings: [] },
    });
    const html = renderToStaticMarkup(<IntelligenceDetectorPage />);
    expect(html).toContain('Latest run failed');
    expect(html).toContain('permission denied fetching repositories');
    expect(html).not.toContain('Create index');
  });

  it('surfaces an error box when the findings fetch fails', () => {
    swrByKey.set('intelligence-detectors', {
      isLoading: false,
      data: {
        detectors: [
          {
            detector_id: 'stale-open',
            name: 'Stale open cases',
            description: 'desc',
            config: { enabled: true },
          },
        ],
      },
    });
    swrByKey.set('intelligence-detector-findings::stale-open::25', {
      isLoading: false,
      error: new Error('Request failed: 500'),
    });
    const html = renderToStaticMarkup(<IntelligenceDetectorPage />);
    expect(html).toContain('Failed to load findings');
    expect(html).toContain('Request failed: 500');
  });
});
