import { describe, expect, it } from 'vitest';
import type { FindingStatus, FindingVerificationStatus } from '@arbitra/shared';
import {
  FINDING_STATUS_COLORS,
  FINDING_STATUS_COLOR_FALLBACK,
  FINDING_VERIFICATION_COLORS,
  FINDING_VERIFICATION_COLOR_FALLBACK,
  findingStatusColor,
  findingVerificationColor,
} from '../badge-colors';

// Mirror of the `FindingStatus` union (packages/shared/src/types/finding.ts).
// Kept explicit so a future enum addition that isn't reflected in
// FINDING_STATUS_COLORS fails this test instead of silently rendering the
// neutral fallback. The `satisfies` check below ties this list to the type.
const ALL_FINDING_STATUSES = [
  'open',
  'accepted',
  'fixed',
  'waived',
  'contested',
  'resolved',
  'waiver_proposed',
  'waived_on_completion',
] as const satisfies readonly FindingStatus[];

describe('FINDING_STATUS_COLORS', () => {
  it('has a colour entry for every FindingStatus member', () => {
    for (const status of ALL_FINDING_STATUSES) {
      expect(FINDING_STATUS_COLORS[status]).toBeTruthy();
    }
  });

  it('has no extra keys beyond the known statuses', () => {
    expect(Object.keys(FINDING_STATUS_COLORS).sort()).toEqual(
      [...ALL_FINDING_STATUSES].sort(),
    );
  });
});

describe('findingStatusColor', () => {
  it('returns the mapped colour for a known status', () => {
    expect(findingStatusColor('open')).toBe(FINDING_STATUS_COLORS.open);
  });

  it('falls back to the neutral pill for an unknown status', () => {
    expect(findingStatusColor('totally-unknown')).toBe(FINDING_STATUS_COLOR_FALLBACK);
  });
});

// Mirror of the `FindingVerificationStatus` union
// (packages/shared/src/types/finding.ts) — same exhaustiveness contract as
// ALL_FINDING_STATUSES above.
const ALL_VERIFICATION_STATUSES = [
  'confirmed',
  'refuted',
  'uncertain',
  'unverified',
] as const satisfies readonly FindingVerificationStatus[];

describe('FINDING_VERIFICATION_COLORS', () => {
  it('has a colour entry for every FindingVerificationStatus member', () => {
    for (const status of ALL_VERIFICATION_STATUSES) {
      expect(FINDING_VERIFICATION_COLORS[status]).toBeTruthy();
    }
  });

  it('has no extra keys beyond the known statuses', () => {
    expect(Object.keys(FINDING_VERIFICATION_COLORS).sort()).toEqual(
      [...ALL_VERIFICATION_STATUSES].sort(),
    );
  });
});

describe('findingVerificationColor', () => {
  it('returns the mapped colour for a known status', () => {
    expect(findingVerificationColor('refuted')).toBe(FINDING_VERIFICATION_COLORS.refuted);
  });

  it('falls back to the neutral pill for an unknown status', () => {
    expect(findingVerificationColor('totally-unknown')).toBe(
      FINDING_VERIFICATION_COLOR_FALLBACK,
    );
  });
});
