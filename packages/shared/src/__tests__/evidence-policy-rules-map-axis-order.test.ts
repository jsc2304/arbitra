/**
 * @file Regression coverage for issue #780's "related" finding: two seed
 * scripts (`scripts/seed-demo-data.ts`)
 * used to write `EvidencePolicyRulesMap` track-first
 * (`{ direct: TrackPolicyMap, manual: TrackPolicyMap }`) while
 * `CompletenessEvaluator.getEffectivePolicyRule` indexes it risk-first
 * (`rules[risk_level][validation_track]`, see `types/evidence.ts`). A
 * track-first policy document is silently unreachable — every case on that
 * project falls through to the built-in default and the seeded
 * customization never applies.
 *
 * `scripts/` is not an npm workspace, so `npm run typecheck` never sees it —
 * confirmed by running `tsc` directly against the old literal:
 * `error TS2353: Object literal may only specify known properties, and
 * 'direct' does not exist in type 'Partial<Record<RiskLevel, ...>>'`. The
 * type system would have caught this; it was just never asked to look. The
 * fix removes the hand-rolled literal from both scripts in favour of
 * `buildPolicyRulesFromPreset`, which is risk-first by construction and does
 * live inside a typechecked, tested workspace — this test pins that shape.
 */
import { describe, expect, it } from 'vitest';
import type { EvidencePolicyRulesMap } from '../types/evidence.js';
import {
  buildPolicyRulesFromPreset,
  DEFAULT_DIRECT_TRACK_POLICY,
  DEFAULT_MANUAL_TRACK_POLICY,
} from '../index.js';

describe('EvidencePolicyRulesMap axis order (risk-first, track-second)', () => {
  it('the seed scripts now build the map via buildPolicyRulesFromPreset, which is risk-first by construction', () => {
    // What `scripts/seed-demo-data.ts`
    // write today: `rules: buildPolicyRulesFromPreset({})`. Reverting either
    // script back to `{ direct: DEFAULT_DIRECT_TRACK_POLICY, manual:
    // DEFAULT_MANUAL_TRACK_POLICY }` would not fail this test directly (the
    // seed scripts have no test runner of their own — see the file comment),
    // but it would reintroduce the exact shape this test asserts is wrong:
    // a map keyed by ValidationTrack at the top level instead of RiskLevel.
    const rules: EvidencePolicyRulesMap = buildPolicyRulesFromPreset({});

    expect(rules.low?.direct).toEqual(DEFAULT_DIRECT_TRACK_POLICY.low);
    expect(rules.medium?.direct).toEqual(DEFAULT_DIRECT_TRACK_POLICY.medium);
    expect(rules.high?.manual).toEqual(DEFAULT_MANUAL_TRACK_POLICY.high);
    expect(rules.critical?.manual).toEqual(DEFAULT_MANUAL_TRACK_POLICY.critical);

    // Resolver shape check: `rules[risk_level][validation_track]` must hit,
    // for every cell — the exact lookup `getEffectivePolicyRule` performs.
    // A track-first map (`rules[validation_track][risk_level]`) would leave
    // every one of these `undefined`, since 'low'/'medium'/'high'/'critical'
    // are never valid top-level keys on that shape.
    for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
      for (const track of ['direct', 'manual'] as const) {
        expect(rules[risk]?.[track], `${risk}/${track}`).toBeDefined();
      }
    }
  });
});
