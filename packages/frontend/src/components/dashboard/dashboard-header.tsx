'use client';

import { motion } from 'framer-motion';
import { useAuth } from '../../providers/auth-provider';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function DashboardHeader() {
  const { user } = useAuth();
  const name = user?.displayName?.split(' ')[0] ?? 'there';

  return (
    <motion.div
      className="mb-8"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      <p className="text-sm text-gray-500 dark:text-gray-400">{formatDate()}</p>
      <h1 className="mt-1 text-2xl md:text-3xl font-extrabold text-gray-900 dark:text-gray-100">
        {getGreeting()}, {name}
      </h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Here&apos;s what needs your attention today.
      </p>
    </motion.div>
  );
}
