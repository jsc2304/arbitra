'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';

interface Tip {
  id: string;
  title: string;
  description: string;
  link: string;
}

const ALL_TIPS: Tip[] = [
  {
    id: 'cmd-k',
    title: 'Quick Search with Cmd+K',
    description: 'Press Cmd+K (or Ctrl+K) to instantly search cases, findings, comments, and documentation.',
    link: '/docs#getting-started',
  },
  {
    id: 'knowledge-assets',
    title: 'Set Up Knowledge Assets',
    description: 'Add coding patterns and guidelines so Arbitra reviews code against your team standards.',
    link: '/docs#knowledge-rules',
  },
  {
    id: 'rule-sets',
    title: 'Configure Rule Sets',
    description: 'Define automated checks per project to catch issues early and consistently.',
    link: '/docs#knowledge-rules',
  },
  {
    id: 'courtroom',
    title: 'The Courtroom View',
    description: 'Use the Courtroom for efficient decision-making with findings and evidence side by side.',
    link: '/docs#courtroom-view',
  },
  {
    id: 'evidence-policies',
    title: 'Evidence Policies by Risk',
    description: 'Require more evidence for high-risk changes to ensure thorough validation.',
    link: '/docs#evidence-policies',
  },
  {
    id: 'observatory',
    title: 'Track Team Metrics',
    description: 'The Observatory shows approval rates, throughput, and team activity at a glance.',
    link: '/docs#observatory-view',
  },
  {
    id: 'validation-tracks',
    title: 'Direct vs. Manual Tracks',
    description: 'Choose between automated validation and manual review flows per case.',
    link: '/docs#validation-tracks',
  },
  {
    id: 'launcher',
    title: 'Click the Logo to Navigate',
    description: 'The Arbitra logo opens a visual launcher for quick navigation to any section.',
    link: '/docs#getting-started',
  },
];

const TIPS_PER_PAGE = 3;

function getDailyOffset(): number {
  const day = Math.floor(Date.now() / 86_400_000);
  return day % ALL_TIPS.length;
}

export function TipsSection() {
  const tips = useMemo(() => {
    const offset = getDailyOffset();
    const result: Tip[] = [];
    for (let i = 0; i < TIPS_PER_PAGE; i++) {
      result.push(ALL_TIPS[(offset + i) % ALL_TIPS.length]!);
    }
    return result;
  }, []);

  return (
    <div className="mt-8">
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4">Tips & Tricks</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {tips.map((tip, i) => (
          <motion.div
            key={tip.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1 + i * 0.08 }}
          >
            <Link
              href={tip.link}
              className="block h-full rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised p-5 shadow-sm hover:shadow-md hover:border-accent dark:hover:border-accent-hover transition-all group"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex-shrink-0 h-8 w-8 rounded-lg bg-secondary-50 dark:bg-secondary-950/50 flex items-center justify-center text-secondary-600 dark:text-secondary-400">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                  </svg>
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 group-hover:text-accent-700 dark:group-hover:text-accent-300 transition-colors">
                    {tip.title}
                  </p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                    {tip.description}
                  </p>
                </div>
              </div>
            </Link>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
