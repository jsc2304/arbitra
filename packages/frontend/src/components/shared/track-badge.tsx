import { Badge } from './badge';

// Colour tokens only — migrated from `border border-<color>` to ring colours
// (#658); the ring is applied by Badge's `soft` tone.
const trackColors: Record<string, string> = {
  direct: 'bg-corp-blue/15 text-corp-dark ring-corp-blue/40 dark:bg-corp-blue/20 dark:text-corp-blue dark:ring-transparent',
  manual: 'bg-secondary-100 text-secondary-700 ring-secondary-200 dark:bg-secondary-950/50 dark:text-secondary-300 dark:ring-transparent',
};

const trackLabels: Record<string, string> = {
  direct: 'Direct',
  manual: 'Manual',
};

const FALLBACK_COLOR = 'bg-gray-100 text-gray-700 ring-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:ring-transparent';

// Bolt icon for direct (automated)
function DirectIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" />
    </svg>
  );
}

// Hand icon for manual
function ManualIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.05 4.575a1.575 1.575 0 1 0-3.15 0v3m3.15-3v-1.5a1.575 1.575 0 0 1 3.15 0v1.5m-3.15 0 .075 5.925m3.075-5.925v-1.5a1.575 1.575 0 0 1 3.15 0v1.5m-3.15 0 .075 5.925M13.5 3.525a1.575 1.575 0 0 1 3.15 0v1.5m0 0v3.675m0-3.675a1.575 1.575 0 0 1 3.15 0v5.043M6.9 7.575V12m6.6 0v3.75m0-6.45a3.375 3.375 0 0 1 6.75 0v6.637c0 2.622-1.847 4.88-4.403 5.401a7.473 7.473 0 0 1-3.898-.044 6.006 6.006 0 0 1-3.048-2.08l-3.39-4.236a1.607 1.607 0 0 1 2.135-2.369l1.456 1.092" />
    </svg>
  );
}

interface TrackBadgeProps {
  track: string;
}

export function TrackBadge({ track }: TrackBadgeProps) {
  const color = trackColors[track] ?? FALLBACK_COLOR;
  const label = trackLabels[track] ?? track;
  const Icon = track === 'manual' ? ManualIcon : DirectIcon;

  return (
    <Badge size="xs" tone="soft" colorClassName={color} icon={<Icon className="h-3 w-3" />}>
      {label}
    </Badge>
  );
}
