'use client';

import type { FindingSeverity } from '@arbitra/shared';
import { Badge } from './badge';

// Colour tokens only (bg/text/ring-colour). Structure (radius, size, ring-1)
// is owned by <Badge>. Migrated from `border border-<color>` to ring colours
// (#658) — the ring itself is applied by Badge's `soft` tone.
const severityConfig: Record<FindingSeverity, { label: string; className: string }> = {
  info: { label: 'Info', className: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-transparent' },
  low: { label: 'Low', className: 'bg-corp-green/15 text-corp-dark ring-corp-green/40 dark:bg-corp-green/20 dark:text-corp-green dark:ring-transparent' },
  medium: { label: 'Medium', className: 'bg-corp-yellow/20 text-corp-dark ring-corp-yellow/60 dark:bg-corp-yellow/20 dark:text-corp-yellow dark:ring-transparent' },
  high: { label: 'High', className: 'bg-corp-orange/15 text-corp-dark ring-corp-orange/40 dark:bg-corp-orange/20 dark:text-corp-orange dark:ring-transparent' },
  critical: { label: 'Critical', className: 'bg-corp-red/15 text-corp-dark ring-corp-red/40 dark:bg-corp-red/20 dark:text-corp-red dark:ring-transparent' },
};

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  const config = severityConfig[severity] ?? {
    label: severity,
    className: 'bg-gray-100 text-gray-700 ring-gray-200 dark:ring-transparent',
  };

  return (
    <Badge size="xs" tone="soft" colorClassName={config.className}>
      {config.label}
    </Badge>
  );
}
