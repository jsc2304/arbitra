'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { extractFirestoreCreateIndexUrl } from '@arbitra/shared';
import { api } from '../../../../../lib/api-client';
import { useIsAdmin } from '../../../../../hooks/use-is-admin';
import { detectorThresholds } from '../../../../../components/intelligence/thresholds';
import { RelativeTime } from '../../../../../components/shared/relative-time';

/**
 * `/observatory/intelligence/detectors/:detectorId` — admin-only drill-down
 * for one detector. Renders the detector's name/description (from the
 * parent `listDetectors` endpoint), its configured thresholds (read-only),
 * and a recent-findings list (cases whose `intelligence_signature` starts
 * with this detector's id).
 *
 * Gating: client-side via `useIsAdmin()` — the hook's `isLoading` flag
 * keeps admins from seeing the denial card flash during the first
 * `/users/me` fetch. Defense-in-depth is server-side: every API route
 * this page calls is guarded by `requireRole(..., ['admin'])`, so a
 * non-admin who bypasses the client gate still can't fetch any data.
 */
export default function IntelligenceDetectorPage() {
  // `useParams()` matches the convention used in other `[id]` client-
  // component pages in this app (e.g. `app/cases/[caseId]/page.tsx`).
  const params = useParams<{ detectorId: string }>();
  const detectorId = params.detectorId;
  const { isAdmin, isLoading: isAdminLoading } = useIsAdmin();

  // We re-use the parent page's `listDetectors` endpoint and find the
  // detector by id — there is no single-detector GET endpoint, and
  // adding one just for this page would be redundant.
  const detectorsSwr = useSWR(
    isAdmin ? 'intelligence-detectors' : null,
    () => api.intelligence.listDetectors(),
  );

  const findingsSwr = useSWR(
    isAdmin ? ['intelligence-detector-findings', detectorId, 25] : null,
    () => api.intelligence.detectorFindings(detectorId, { limit: 25 }),
  );

  if (isAdminLoading) {
    return (
      <div className="mx-auto max-w-4xl p-6 space-y-6" aria-busy="true">
        <SkeletonBlock lines={6} />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <div className="rounded-lg border border-dashed border-gray-300 dark:border-border-subtle bg-surface-base dark:bg-surface-base/50 p-8 text-center">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Admin access required
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Detector drill-down pages are only available to administrators.
          </p>
          <Link
            href="/observatory"
            className="mt-4 inline-block text-xs font-medium text-accent hover:text-accent-700 dark:hover:text-accent-300"
          >
            ← Back to Observatory
          </Link>
        </div>
      </div>
    );
  }

  const detector = detectorsSwr.data?.detectors.find(
    (d) => d.detector_id === detectorId,
  );
  const thresholds = detectorThresholds(detectorId);

  return (
    <div className="mx-auto max-w-4xl p-6 space-y-8">
      <header className="space-y-1">
        <div className="text-xs text-gray-500 dark:text-gray-400">
          <Link
            href="/observatory"
            className="hover:text-gray-700 dark:hover:text-gray-300"
          >
            Observatory
          </Link>
          <span className="mx-1">/</span>
          <Link
            href="/observatory/intelligence"
            className="hover:text-gray-700 dark:hover:text-gray-300"
          >
            Intelligence
          </Link>
          <span className="mx-1">/</span>
          <span className="font-mono">{detectorId}</span>
        </div>
        {detectorsSwr.error ? (
          <ErrorBox>
            Failed to load detector: {formatErr(detectorsSwr.error)}
          </ErrorBox>
        ) : detectorsSwr.isLoading ? (
          <SkeletonBlock lines={2} />
        ) : detector ? (
          <>
            <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-50">
              {detector.name}
            </h1>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {detector.description}
            </p>
          </>
        ) : (
          <div className="rounded-md border border-yellow-300 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-900/20 px-4 py-3 text-sm text-yellow-800 dark:text-yellow-200">
            Unknown detector:{' '}
            <span className="font-mono">{detectorId}</span>. It may have
            been removed.
          </div>
        )}
      </header>

      {detector?.last_run?.error && (
        <section aria-labelledby="last-error-heading" className="space-y-3">
          <h2
            id="last-error-heading"
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            Latest run failed
          </h2>
          <LastRunErrorPanel error={detector.last_run.error} />
        </section>
      )}

      <section aria-labelledby="thresholds-heading" className="space-y-3">
        <div>
          <h2
            id="thresholds-heading"
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            Thresholds
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Read-only. Configured in the backend constant{' '}
            <code className="font-mono">THRESHOLDS</code>.
          </p>
        </div>
        {/*
          Threshold labels come from
          `packages/frontend/src/components/intelligence/thresholds.ts`,
          which duplicates the backend `THRESHOLDS` constant (see
          `packages/backend/src/services/intelligence/config.ts`). Any
          threshold change is a coordinated edit across both files.
          Follow-up: unify threshold presentation behind a shared
          surface so the frontend no longer ships a hand-maintained copy.
        */}
        {thresholds.length === 0 ? (
          <p className="text-xs italic text-gray-400 dark:text-gray-500">
            This detector does not expose any configurable thresholds.
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr] rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised px-4 py-3 text-sm">
            {thresholds.map((t) => (
              <div
                key={t.label}
                className="contents"
              >
                <dt className="text-gray-500 dark:text-gray-400">{t.label}</dt>
                <dd className="font-mono tabular-nums text-gray-900 dark:text-gray-100">
                  {t.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section aria-labelledby="findings-heading" className="space-y-3">
        <div>
          <h2
            id="findings-heading"
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            Recent findings
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Up to 25 most recent cases attributed to this detector, newest
            first.
          </p>
        </div>
        {findingsSwr.error ? (
          <ErrorBox>
            Failed to load findings: {formatErr(findingsSwr.error)}
          </ErrorBox>
        ) : findingsSwr.isLoading ? (
          <SkeletonBlock lines={4} />
        ) : (findingsSwr.data?.findings ?? []).length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 dark:border-border-subtle bg-surface-base dark:bg-surface-base/50 p-8 text-center text-sm text-gray-500 dark:text-gray-400">
            No cases have been attributed to this detector yet.
          </div>
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-border-subtle rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised">
            {(findingsSwr.data?.findings ?? []).map((f) => (
              <li key={f.case_id} className="p-3">
                <Link
                  href={`/cases/${f.case_id}`}
                  className="flex items-baseline justify-between gap-4 text-sm hover:bg-surface-base dark:hover:bg-border-subtle/40 -mx-3 -my-3 px-3 py-3 rounded-md"
                >
                  <span className="min-w-0 truncate font-medium text-gray-900 dark:text-gray-100">
                    {f.title}
                  </span>
                  <RelativeTime
                    timestamp={f.created_at}
                    className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers (mirror the parent page's small helpers — kept local so the two
// pages can evolve independently without coupling through a shared module).
// ---------------------------------------------------------------------------

function formatErr(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error';
}

function SkeletonBlock({ lines }: { lines: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-12 animate-pulse rounded-md bg-surface-base dark:bg-border-subtle/40"
        />
      ))}
    </div>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
      {children}
    </div>
  );
}

/**
 * Full (untruncated) per-detector error message from the most recent
 * intelligence run, plus a one-click "Create index" link when the message
 * embeds a Firestore composite-index console URL (the common shape for a
 * `FAILED_PRECONDITION` — the query needs an index that doesn't exist yet).
 *
 * Unlike the collapsed run-history table on the parent observatory page
 * (which visually truncates each detector's error to keep rows scannable),
 * this drill-down is the place an admin lands specifically to diagnose one
 * detector's failure — so the message renders in full, wrapped, monospace.
 */
function LastRunErrorPanel({ error }: { error: string }) {
  const createIndexUrl = extractFirestoreCreateIndexUrl(error);
  return (
    <div className="space-y-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 p-4">
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-red-800 dark:text-red-300">
        {error}
      </pre>
      {createIndexUrl && (
        <a
          href={createIndexUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md bg-red-700 dark:bg-red-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 dark:hover:bg-red-700"
        >
          Create index
          <svg
            className="h-3 w-3"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
            />
          </svg>
        </a>
      )}
    </div>
  );
}
