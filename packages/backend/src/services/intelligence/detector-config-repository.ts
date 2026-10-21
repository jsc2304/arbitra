import type { DetectorConfig, DetectorConfigMap } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';

/**
 * `intelligence_config` holds a single document `detectors` whose body is the
 * full `DetectorConfigMap`. Single-doc storage keeps reads cheap (one get per
 * run) and avoids a collection-query + composite index for what is
 * fundamentally a tiny config blob. Writes merge partial updates so parallel
 * toggles to different detector ids never clobber each other.
 */
export const CONFIG_DOC_ID = 'detectors';

export class DetectorConfigRepository {
  private doc() {
    return collections.intelligenceConfig().doc(CONFIG_DOC_ID);
  }

  /**
   * Returns the full config map. An absent doc resolves to `{}` — callers
   * MUST treat unknown detector ids as enabled (default-on) so adding a new
   * detector in code doesn't require a config write before the first run.
   */
  async getAll(): Promise<DetectorConfigMap> {
    const snap = await this.doc().get();
    if (!snap.exists) return {};
    return (snap.data() as DetectorConfigMap | undefined) ?? {};
  }

  /**
   * Toggle a single detector. Merges into the config doc so concurrent
   * writes to different detector ids don't race. Uses set-with-merge so
   * first-write-ever creates the doc.
   */
  async setEnabled(
    detectorId: string,
    enabled: boolean,
    byUserId: string,
  ): Promise<DetectorConfig> {
    const now = new Date().toISOString();
    const entry: DetectorConfig = {
      enabled,
      updated_at: now,
      updated_by: byUserId,
    };
    await this.doc().set({ [detectorId]: entry }, { merge: true });
    return entry;
  }
}
