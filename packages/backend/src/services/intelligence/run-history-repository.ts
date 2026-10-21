import type { IntelligenceRun } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';

/**
 * Persistence for `intelligence_runs`. One doc per scheduler (or manual
 * admin) invocation, keyed by `run_id`. The observatory UI (PR 5) paginates
 * the list by `started_at DESC`; the Firestore index for that ordering is
 * intentionally NOT added in this PR — see the PR body for the TODO.
 */
export class RunHistoryRepository {
  private coll() {
    return collections.intelligenceRuns();
  }

  /** Persist a completed run. Idempotent on `run_id` — a repeat write overwrites. */
  async create(run: IntelligenceRun): Promise<void> {
    await this.coll().doc(run.run_id).set(run);
  }

  /** Fetch a single run by id. Returns `undefined` when the doc doesn't exist. */
  async get(runId: string): Promise<IntelligenceRun | undefined> {
    const snap = await this.coll().doc(runId).get();
    return snap.exists ? (snap.data() as IntelligenceRun) : undefined;
  }

  /**
   * Page the run history by `started_at DESC`. `cursor` is the `started_at`
   * ISO timestamp of the last row from the previous page; subsequent pages
   * request rows strictly older than that. `next_cursor` is the
   * `started_at` of the last row in the returned page, or `undefined` when
   * the page was short (end of history).
   */
  async list(params: { limit?: number; cursor?: string }): Promise<{
    runs: IntelligenceRun[];
    next_cursor?: string;
  }> {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
    let q = this.coll().orderBy('started_at', 'desc') as FirebaseFirestore.Query<IntelligenceRun>;
    if (params.cursor) {
      q = q.where('started_at', '<', params.cursor) as FirebaseFirestore.Query<IntelligenceRun>;
    }
    const snap = await q.limit(limit).get();
    const runs = snap.docs.map((d) => d.data());
    const next_cursor =
      runs.length === limit ? runs[runs.length - 1]?.started_at : undefined;
    return next_cursor ? { runs, next_cursor } : { runs };
  }
}
