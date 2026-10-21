'use client';

import { findingStatusColor } from '../../lib/badge-colors';
import { Badge } from './badge';

/**
 * `<FindingStatusBadge>` — the small finding-status pill (#658).
 *
 * Extracted from an identical inline span that was copy-pasted into
 * `case/findings-panel.tsx` and `courtroom/finding-card.tsx`
 * (`inline-flex … rounded-full px-2 py-0.5 text-[11px] … ${findingStatusColor()}`).
 * Both sites rendered the raw `finding.status` string as the label, so this
 * keeps that behaviour. Colour comes from the single-source-of-truth
 * `findingStatusColor` map in `lib/badge-colors`; structure comes from
 * <Badge> (this drops the arbitrary `text-[11px]` for the `xs` scale).
 *
 * Note: these are bg+text-only colour tokens (no ring), so the badge uses the
 * `solid` tone to stay visually identical to the old inline pill.
 */
export function FindingStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <Badge size="xs" tone="solid" colorClassName={findingStatusColor(status)} className={className}>
      {status}
    </Badge>
  );
}
