import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIRECT_TRACK_POLICY,
  DEFAULT_MANUAL_TRACK_POLICY,
  type EvidencePolicyRule,
  type EvidencePolicyRulesMap,
} from '@arbitra/shared';
import {
  buildDefaultRulesMap,
  detectProfile,
  PROFILES,
} from '../evidence-policy-profiles';

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function buildBalancedShape(): EvidencePolicyRulesMap {
  const out: EvidencePolicyRulesMap = {};
  for (const risk of RISK_LEVELS) {
    out[risk] = {
      direct: clone(DEFAULT_DIRECT_TRACK_POLICY[risk]),
      manual: clone(DEFAULT_MANUAL_TRACK_POLICY[risk]),
    };
  }
  return out;
}

function buildFastIterationShape(): EvidencePolicyRulesMap {
  const out: EvidencePolicyRulesMap = {};
  for (const risk of RISK_LEVELS) {
    out[risk] = {
      direct: clone(DEFAULT_DIRECT_TRACK_POLICY[risk]),
      manual: clone(DEFAULT_DIRECT_TRACK_POLICY[risk]),
    };
  }
  return out;
}

function buildStrictShape(): EvidencePolicyRulesMap {
  return clone(PROFILES['strict-regulated'].rules);
}

describe('detectProfile', () => {
  const defaults = buildDefaultRulesMap();

  it("returns 'balanced' for the unedited Default Manual Track shape", () => {
    expect(detectProfile(buildBalancedShape(), defaults)).toBe('balanced');
  });

  it("returns 'fast-iteration' for the Default Direct Track shape on both tracks", () => {
    expect(detectProfile(buildFastIterationShape(), defaults)).toBe(
      'fast-iteration',
    );
  });

  it("returns 'strict-regulated' for the Strict shape", () => {
    expect(detectProfile(buildStrictShape(), defaults)).toBe(
      'strict-regulated',
    );
  });

  it("returns 'custom' when one cell deviates from every profile", () => {
    const tweaked = buildBalancedShape();
    const cell: EvidencePolicyRule = {
      ...tweaked.medium!.manual!,
      // ci_result alone is not part of any profile's medium-manual cell
      required_evidence_types: ['ci_result'],
      optional_evidence_types: ['unit_test_result'],
      four_eyes_required: true,
      allow_self_approval: true,
    };
    tweaked.medium!.manual = cell;
    expect(detectProfile(tweaked, defaults)).toBe('custom');
  });

  it('matches a profile when input has empty cells that fall through to defaults matching that profile', () => {
    // An empty rules map should be treated as "every cell is the
    // system default" — i.e. 'balanced'.
    const empty: EvidencePolicyRulesMap = {};
    expect(detectProfile(empty, defaults)).toBe('balanced');

    // Same for a partial map with only a few cells populated to the
    // balanced shape.
    const partial: EvidencePolicyRulesMap = {
      high: {
        direct: clone(DEFAULT_DIRECT_TRACK_POLICY.high),
      },
    };
    expect(detectProfile(partial, defaults)).toBe('balanced');
  });
});

describe('PROFILES shape integrity', () => {
  it('strict-regulated requires four_eyes at every level on both tracks', () => {
    const strict = PROFILES['strict-regulated'].rules;
    for (const risk of RISK_LEVELS) {
      expect(strict[risk]!.direct!.four_eyes_required).toBe(true);
      expect(strict[risk]!.manual!.four_eyes_required).toBe(true);
      expect(strict[risk]!.direct!.allow_self_approval).toBe(false);
      expect(strict[risk]!.manual!.allow_self_approval).toBe(false);
    }
  });

  it('strict-regulated includes screenshot only at high/critical', () => {
    const strict = PROFILES['strict-regulated'].rules;
    expect(strict.low!.direct!.required_evidence_types).not.toContain(
      'screenshot',
    );
    expect(strict.medium!.direct!.required_evidence_types).not.toContain(
      'screenshot',
    );
    expect(strict.high!.direct!.required_evidence_types).toContain(
      'screenshot',
    );
    expect(strict.critical!.direct!.required_evidence_types).toContain(
      'screenshot',
    );
  });
});
