'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import type { Case } from '@arbitra/shared';
import { StatusBadge } from '../shared/status-badge';
import PriorityBadge from '../shared/priority-badge';
import EmptyState from '../shared/empty-state';
import SectionHeader from '../shared/section-header';
import { useAuth } from '../../providers/auth-provider';
import { RelativeTime } from '../shared/relative-time';
import Card from '../shared/card';
import { listVariants, itemVariants } from '../../lib/animation-variants';

const MAX_VISIBLE = 8;

interface MyCasesSectionProps {
  cases: Case[];
}

export function MyCasesSection({ cases }: MyCasesSectionProps) {
  const { user } = useAuth();
  const hasMore = cases.length > MAX_VISIBLE;

  return (
    <Card id="my-cases" padding="none" elevation="raised">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-border-subtle">
        <SectionHeader
          title="My Cases"
          count={cases.length > 0 ? cases.length : undefined}
        />
      </div>
      <div className="p-4">
        {cases.length === 0 ? (
          <EmptyState
            title="No active cases"
            description="Cases you own will appear here."
          />
        ) : (
          <motion.ul className="space-y-1" variants={listVariants} initial="hidden" animate="visible">
            {cases.slice(0, MAX_VISIBLE).map((c) => (
              <motion.li key={c.case_id} variants={itemVariants}>
                <Link
                  href={`/cases/${c.case_id}`}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-base dark:hover:bg-border-subtle/50 transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate group-hover:text-accent-700 dark:group-hover:text-accent-300 transition-colors" title={c.title}>
                      {c.title}
                    </p>
                  </div>
                  <StatusBadge status={c.status} size="sm" />
                  <PriorityBadge priority={c.priority} size="sm" />
                  <RelativeTime timestamp={c.updated_at} className="text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap" />
                </Link>
              </motion.li>
            ))}
          </motion.ul>
        )}
        {hasMore && (
          <div className="mt-3 text-center">
            <Link
              href={user?.uid ? `/board?owner_user_id=${user.uid}` : '/board'}
              className="text-sm text-accent-700 dark:text-accent-300 hover:underline"
            >
              View all {cases.length} cases on Board
            </Link>
          </div>
        )}
      </div>
    </Card>
  );
}
