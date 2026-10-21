'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';

interface MetricsSummaryProps {
  myCasesCount: number;
  attentionCount: number;
  approvalRate: number;
  totalOpen: number;
  staleCount?: number;
  /**
   * Number of cases that have actually been decided (approved + rejected +
   * done) — the denominator behind `approvalRate`. When `0` (or omitted as a
   * brand-new workspace), a 0% rate reads as "no data yet" → neutral, not the
   * alarm-red used for a genuinely stalled pipeline. See #664.
   */
  decidedCount?: number;
}

function AnimatedNumber({ value, suffix = '' }: { value: number; suffix?: string }) {
  const [display, setDisplay] = useState(0);
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!isInView || reducedMotion) {
      setDisplay(value);
      return;
    }
    let start: number | null = null;
    let raf: number;
    const duration = 800;

    function step(ts: number) {
      if (!start) start = ts;
      const progress = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(eased * value));
      if (progress < 1) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, isInView, reducedMotion]);

  return (
    <span ref={ref}>
      {display}
      {suffix}
    </span>
  );
}

function StatCard({
  label,
  value,
  suffix,
  accent,
  index,
}: {
  label: string;
  value: number;
  suffix?: string;
  accent?: string;
  index: number;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      ref={ref}
      className="bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm p-6"
      initial={reducedMotion ? false : { opacity: 0, y: 16 }}
      animate={isInView ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: 0.5, delay: index * 0.08 }}
    >
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`mt-2 text-3xl font-semibold ${accent ?? 'text-gray-900 dark:text-gray-100'}`}>
        <AnimatedNumber value={value} suffix={suffix} />
      </p>
    </motion.div>
  );
}

/**
 * Approval-rate accent: green when healthy (>= 50%), neutral when low,
 * red when zero. 0% in green misreads as "good" when it actually signals a
 * stalled pipeline.
 *
 * #664: a 0% rate is only alarming once at least one case has been decided.
 * When `decidedCount` is passed and is 0, the workspace has no decisions yet
 * (brand-new / empty) → neutral gray, not alarm-red. Omitting `decidedCount`
 * preserves the legacy behavior (0% → red).
 */
const NEUTRAL_ACCENT_CLASS = 'text-gray-700 dark:text-gray-300';

export function approvalRateAccent(rate: number, decidedCount?: number): string {
  if (decidedCount !== undefined && decidedCount <= 0) return NEUTRAL_ACCENT_CLASS;
  if (rate <= 0) return 'text-red-600 dark:text-red-400';
  if (rate < 50) return NEUTRAL_ACCENT_CLASS;
  return 'text-green-600 dark:text-green-400';
}

export function MetricsSummary({ myCasesCount, attentionCount, approvalRate, totalOpen, staleCount = 0, decidedCount }: MetricsSummaryProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
      <a href="#my-cases" className="block">
        <StatCard label="My Active Cases" value={myCasesCount} index={0} />
      </a>
      <StatCard label="Needs Attention" value={attentionCount} accent="text-orange-600 dark:text-orange-400" index={1} />
      <StatCard label="Stale Cases" value={staleCount} accent="text-yellow-600 dark:text-yellow-400" index={2} />
      <StatCard label="Approval Rate" value={approvalRate} suffix="%" accent={approvalRateAccent(approvalRate, decidedCount)} index={3} />
      <StatCard label="Total Open" value={totalOpen} accent="text-accent-700 dark:text-accent-300" index={4} />
    </div>
  );
}
