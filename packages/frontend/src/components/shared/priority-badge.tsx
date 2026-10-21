import { Badge } from './badge';

// Colour tokens only — migrated from `border border-<color>` to ring colours
// (#658); the ring is applied by Badge's `soft` tone.
const priorityColors: Record<string, string> = {
  low: 'bg-gray-100 text-gray-700 ring-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:ring-transparent',
  normal: 'bg-corp-blue/15 text-corp-dark ring-corp-blue/40 dark:bg-corp-blue/20 dark:text-corp-blue dark:ring-transparent',
  high: 'bg-corp-orange/15 text-corp-dark ring-corp-orange/40 dark:bg-corp-orange/20 dark:text-corp-orange dark:ring-transparent',
  urgent: 'bg-corp-red/15 text-corp-dark ring-corp-red/40 dark:bg-corp-red/20 dark:text-corp-red dark:ring-transparent',
};

const priorityLabels: Record<string, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

const FALLBACK_COLOR = 'bg-gray-100 text-gray-700 ring-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:ring-transparent';

// Flame icon for priority
function PriorityIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0 1 12 21 8.25 8.25 0 0 1 6.038 7.047 8.287 8.287 0 0 0 9 9.601a8.983 8.983 0 0 1 3.361-6.867 8.21 8.21 0 0 0 3 2.48Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 0 0 .495-7.468 5.99 5.99 0 0 0-1.925 3.547 5.975 5.975 0 0 1-2.133-1.001A3.75 3.75 0 0 0 12 18Z" />
    </svg>
  );
}

interface PriorityBadgeProps {
  priority: string;
  size?: 'sm' | 'md';
}

export default function PriorityBadge({ priority, size = 'sm' }: PriorityBadgeProps) {
  const color = priorityColors[priority] ?? FALLBACK_COLOR;
  const label = priorityLabels[priority] ?? priority;
  const contextualLabel = `Priority: ${label}`;
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';

  return (
    <Badge size={size} tone="soft" colorClassName={color} icon={<PriorityIcon className={iconSize} />}>
      {contextualLabel}
    </Badge>
  );
}
