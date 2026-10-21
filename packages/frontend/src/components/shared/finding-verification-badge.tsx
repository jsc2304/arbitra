'use client';

import type { FindingVerificationStatus } from '@arbitra/shared';
import { findingVerificationColor } from '../../lib/badge-colors';
import { Badge } from './badge';
import { Tooltip } from './tooltip';

/**
 * `<FindingVerificationBadge>` — the AI-verifier verdict pill.
 *
 * Surfaces the adversarial verification verdict (`verification_status`) next
 * to the finding-status pill. Renders nothing when the status is missing —
 * a finding without a verdict must look exactly as it did before the
 * verification feature existed.
 *
 * When the verifier left a rationale (`verification_note`) the pill gets a
 * hover tooltip carrying it, and the trigger carries an `aria-label` with the
 * verdict + note (the Tooltip primitive is decorative and expects the trigger
 * to hold the accessible name — see `shared/tooltip.tsx`). The trigger is NOT
 * focusable: the badge sits inside interactive ancestors (panel row button,
 * card `role="button"`), and the note is also surfaced as visible text by the
 * host surfaces, so touch and keyboard users don't depend on the tooltip.
 * Colour comes from the single-source-of-truth `findingVerificationColor` map
 * in `lib/badge-colors`; tokens are bg+text-only, so `solid` tone like
 * `FindingStatusBadge`.
 */

const verdictLabels: Record<FindingVerificationStatus, string> = {
  confirmed: 'AI-verified',
  refuted: 'AI-refuted',
  uncertain: 'AI-uncertain',
  unverified: 'Unverified',
};

export function FindingVerificationBadge({
  status,
  note,
  className,
}: {
  status?: FindingVerificationStatus;
  note?: string;
  className?: string;
}) {
  if (!status) return null;

  const label = verdictLabels[status] ?? status;

  const badge = (
    <Badge
      size="xs"
      tone="solid"
      colorClassName={findingVerificationColor(status)}
      className={className}
    >
      {label}
    </Badge>
  );

  if (!note) return badge;

  return (
    <Tooltip label={note}>
      {/* role="img" makes the aria-label the accessible name (a bare span's
          aria-label is ignored by screen readers) so the note is announced;
          no tabIndex — the badge sits inside interactive ancestors and must
          not add a stray tab stop. */}
      <span role="img" aria-label={`${label}: ${note}`} className="inline-flex">
        {badge}
      </span>
    </Tooltip>
  );
}
