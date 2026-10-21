import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import type { DetectorConfig } from '@arbitra/shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/detectors — admin-only roster of the detectors
 * registered in code (`ALL_DETECTORS`) merged with the runtime enable-flag
 * config (`intelligence_config/detectors`) and each detector's last-run
 * stats (pulled from the most recent `IntelligenceRun`).
 *
 * `last_run` is absent when no run has been persisted yet (fresh
 * deployment). `config.enabled` defaults to true for detectors missing from
 * the config doc. `last_run.error` carries the full (backend-capped)
 * per-detector error message from that run when the detector failed — the
 * observatory drill-down renders it and extracts a Firestore create-index
 * URL from it when present.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const {
      requireRole,
      ALL_DETECTORS,
      DetectorConfigRepository,
      RunHistoryRepository,
    } = await import('@arbitra/backend');
    await requireRole(auth.userId, ['admin']);

    const cfgRepo = new DetectorConfigRepository();
    const runRepo = new RunHistoryRepository();

    const [configMap, recentRuns] = await Promise.all([
      cfgRepo.getAll(),
      runRepo.list({ limit: 1 }),
    ]);

    const lastRunByDetector = new Map<
      string,
      { started_at: string; finding_count: number; error?: string }
    >();
    const latest = recentRuns.runs[0];
    if (latest) {
      for (const s of latest.summaries) {
        lastRunByDetector.set(s.detector_id, {
          started_at: latest.started_at,
          finding_count: s.finding_count,
          ...(s.error ? { error: s.error } : {}),
        });
      }
    }

    const detectors = ALL_DETECTORS.map((d) => {
      const config: DetectorConfig = configMap[d.id] ?? { enabled: true };
      const lastRun = lastRunByDetector.get(d.id);
      return {
        detector_id: d.id,
        name: d.name ?? d.id,
        description: d.description ?? '',
        config,
        ...(lastRun ? { last_run: lastRun } : {}),
      };
    });

    return NextResponse.json({ detectors });
  } catch (error) {
    return handleError(error);
  }
}
