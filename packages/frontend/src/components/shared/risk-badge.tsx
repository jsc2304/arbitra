import type { RiskLevel } from '@arbitra/shared';
import { RISK_PILL_COLORS, RISK_LABELS } from '@/lib/risk-colors';
import { Badge } from './badge';

// Shield icon for risk
function RiskIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0-10.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.75c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.75h-.152c-3.196 0-6.1-1.25-8.25-3.286Zm0 13.036h.008v.008H12v-.008Z" />
    </svg>
  );
}

interface RiskBadgeProps {
  level: string;
  size?: 'sm' | 'md';
}

const FALLBACK_PILL =
  'bg-gray-100 text-gray-700 ring-gray-300 ' +
  'dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-600';

function isRiskLevel(level: string): level is RiskLevel {
  return level in RISK_PILL_COLORS;
}

export function RiskBadge({ level, size = 'sm' }: RiskBadgeProps) {
  const pillClass = isRiskLevel(level) ? RISK_PILL_COLORS[level].pill : FALLBACK_PILL;
  const label = isRiskLevel(level) ? RISK_LABELS[level] : level;
  const contextualLabel = `Risk: ${label}`;
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';

  return (
    <Badge size={size} tone="soft" colorClassName={pillClass} icon={<RiskIcon className={iconSize} />}>
      {contextualLabel}
    </Badge>
  );
}
