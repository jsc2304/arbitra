'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';

import { RelativeTime } from '../shared/relative-time';
import Card from '../shared/card';
import EmptyState from '../shared/empty-state';
import SectionHeader from '../shared/section-header';
import { feedListVariants, feedItemVariants } from '../../lib/animation-variants';

const ACTIVITY_DOT_COLORS: Record<string, string> = {
  case_created: 'bg-accent',
  review_run: 'bg-amber-500',
  rule_run: 'bg-purple-500',
  exploration_run: 'bg-blue-500',
  implementation_run: 'bg-violet-500',
  test_run: 'bg-green-500',
  evidence_collection_run: 'bg-emerald-500',
  manual_validation_run: 'bg-orange-500',
};

function formatType(type: string): string {
  return type
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

interface ActivityItem {
  case_id: string;
  case_title: string;
  type: string;
  summary: string;
  created_at: string;
}


export function RecentActivityFeed({ items }: { items: ActivityItem[] }) {
  const visible = items.slice(0, 10);

  return (
    <Card padding="none" elevation="raised">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-border-subtle">
        <SectionHeader title="Recent Activity" />
      </div>
      <div className="p-4">
        {visible.length === 0 ? (
          <EmptyState title="No recent activity yet" />
        ) : (
          <motion.ul className="space-y-0" variants={feedListVariants} initial="hidden" animate="visible">
            {visible.map((item, i) => {
              const dotColor = ACTIVITY_DOT_COLORS[item.type] ?? 'bg-gray-400';
              return (
                <motion.li key={`${item.case_id}-${item.type}-${i}`} variants={feedItemVariants}>
                  <Link
                    href={`/cases/${item.case_id}`}
                    className="flex gap-3 px-2 py-2.5 rounded-lg hover:bg-surface-base dark:hover:bg-border-subtle/50 transition-colors"
                  >
                    <div className="flex flex-col items-center pt-1.5">
                      <span className={`h-2 w-2 rounded-full ${dotColor}`} />
                      {i < visible.length - 1 && <span className="w-px flex-1 bg-gray-200 dark:bg-gray-700 mt-1" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        <span className="font-medium">{formatType(item.type)}</span>
                        <span className="mx-1.5">&middot;</span>
                        <RelativeTime timestamp={item.created_at} />
                      </p>
                      <p className="text-sm text-gray-900 dark:text-gray-100 truncate" title={item.case_title}>{item.case_title}</p>
                      {item.summary && (
                        <p className="text-xs text-gray-400 dark:text-gray-500 truncate mt-0.5" title={item.summary}>{item.summary}</p>
                      )}
                    </div>
                  </Link>
                </motion.li>
              );
            })}
          </motion.ul>
        )}
        <div className="mt-3 text-center">
          <Link href="/observatory" className="text-sm text-accent-700 dark:text-accent-300 hover:underline">
            View full activity
          </Link>
        </div>
      </div>
    </Card>
  );
}
