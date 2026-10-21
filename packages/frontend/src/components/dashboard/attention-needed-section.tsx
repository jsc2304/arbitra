'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import type { Case } from '@arbitra/shared';
import { StatusBadge } from '../shared/status-badge';
import PriorityBadge from '../shared/priority-badge';
import EmptyState from '../shared/empty-state';
import { RelativeTime } from '../shared/relative-time';
import Card from '../shared/card';
import { listVariants, itemVariants } from '../../lib/animation-variants';

interface AttentionNeededSectionProps {
  cases: Case[];
}

export function AttentionNeededSection({ cases }: AttentionNeededSectionProps) {
  return (
    <Card padding="none" elevation="raised">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-gray-100 dark:border-border-subtle">
        <span className="h-2 w-2 rounded-full bg-orange-500" />
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Needs Attention</h2>
        {cases.length > 0 && (
          <span className="ml-auto text-xs font-medium text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/50 px-2 py-0.5 rounded-full">
            {cases.length}
          </span>
        )}
      </div>
      <div className="p-4">
        {cases.length === 0 ? (
          <EmptyState
            title="All clear"
            description="No cases need your attention right now."
          />
        ) : (
          <motion.ul className="space-y-1" variants={listVariants} initial="hidden" animate="visible">
            {cases.slice(0, 10).map((c) => (
              <motion.li key={c.case_id} variants={itemVariants}>
                <Link
                  href={`/cases/${c.case_id}/courtroom`}
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
      </div>
    </Card>
  );
}
