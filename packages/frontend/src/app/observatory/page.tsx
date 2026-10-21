'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence, useInView, useReducedMotion } from 'framer-motion';
import { api } from '@/lib/api-client';
import Card from '@/components/shared/card';
import { RelativeTime } from '@/components/shared/relative-time';
import { RISK_HEX } from '@/lib/risk-colors';
import {
  approvalRatePillColors,
  approvalRateStatAccent,
} from '@/lib/approval-rate-colors';
import { splitActorRows } from '@/lib/observatory-actor-split';

// ---------------------------------------------------------------------------
// Date range options
// ---------------------------------------------------------------------------

type DateRange = { label: string; days: number | null };
const DATE_RANGES: DateRange[] = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'All time', days: null },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ObservatoryData = Awaited<ReturnType<typeof api.observatory.get>>;

// ---------------------------------------------------------------------------
// Animation constants
// ---------------------------------------------------------------------------

// Global speed: 2x (slow) for everything except bar chart
const SPEED = 2;
// Bar chart runs at 1.5x
const BAR_SPEED = 1.5;
// Default easing
const EASE = 'easeOut' as const;

// ---------------------------------------------------------------------------
// Color maps
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  open: '#6b7280',
  exploration: '#3b82f6',
  ready_for_build: '#8b5cf6',
  in_build: '#6366f1',
  in_validation: '#a855f7',
  in_review: '#f59e0b',
  needs_human_decision: '#f97316',
  verification_pending: '#eab308',
  approved: '#22c55e',
  done: '#10b981',
  rejected: '#ef4444',
};

const RISK_COLORS: Record<string, string> = RISK_HEX;

const SEVERITY_COLORS: Record<string, string> = {
  info: '#64748b',
  low: '#22c55e',
  medium: '#eab308',
  high: '#f97316',
  critical: '#ef4444',
};

const TRACK_COLORS: Record<string, string> = {
  direct: '#6366f1',
  manual: '#a855f7',
};

const ACTIVITY_DOT_COLORS: Record<string, string> = {
  case_created: '#6366f1',
  review_run: '#f59e0b',
  rule_run: '#a855f7',
  exploration_run: '#3b82f6',
  implementation_run: '#8b5cf6',
  test_run: '#22c55e',
  evidence_collection_run: '#10b981',
  manual_validation_run: '#f97316',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLabel(key: string): string {
  return key
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}


// ---------------------------------------------------------------------------
// Case lifecycle ordering — canonical state machine sequence
// ---------------------------------------------------------------------------

const STATUS_ORDER: string[] = [
  'open',
  'exploration',
  'ready_for_build',
  'in_build',
  'in_validation',
  'in_review',
  'needs_human_decision',
  'verification_pending',
  'approved',
  'done',
  'rejected',
];

/** Sort a Record's entries by STATUS_ORDER (unknown keys go to the end). */
function sortByLifecycle(data: Record<string, number>): Record<string, number> {
  const entries = Object.entries(data);
  entries.sort(([a], [b]) => {
    const ia = STATUS_ORDER.indexOf(a);
    const ib = STATUS_ORDER.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// useCountUp — returns an animated number for SVG text etc.
// ---------------------------------------------------------------------------

function useCountUp(target: number, duration: number, animate: boolean) {
  const [display, setDisplay] = useState(animate ? 0 : target);

  useEffect(() => {
    if (!animate) {
      setDisplay(target);
      return;
    }
    let start: number | null = null;
    let raf: number;

    function step(ts: number) {
      if (!start) start = ts;
      const progress = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(eased * target));
      if (progress < 1) {
        raf = requestAnimationFrame(step);
      }
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, animate]);

  return display;
}

// ---------------------------------------------------------------------------
// AnimatedCounter — counts from 0 to target (renders as <span>)
// ---------------------------------------------------------------------------

function AnimatedCounter({
  value,
  duration = 800,
  suffix = '',
  speed = SPEED,
  animate = true,
}: {
  value: number;
  duration?: number;
  suffix?: string;
  speed?: number;
  animate?: boolean;
}) {
  const [display, setDisplay] = useState(animate ? 0 : value);

  useEffect(() => {
    if (!animate) {
      setDisplay(value);
      return;
    }
    const ms = duration * speed;
    let start: number | null = null;
    let raf: number;

    function step(ts: number) {
      if (!start) start = ts;
      const progress = Math.min((ts - start) / ms, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(eased * value));
      if (progress < 1) {
        raf = requestAnimationFrame(step);
      }
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, speed, animate]);

  return (
    <span>
      {display}
      {suffix}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SteppedCounter — total that counts +1 as each bar value pops in
// ---------------------------------------------------------------------------

function SteppedCounter({
  values,
  popTimes,
  animate,
}: {
  values: number[];
  popTimes: number[];
  animate: boolean;
}) {
  const total = values.reduce((s, v) => s + v, 0);
  const [display, setDisplay] = useState(animate ? 0 : total);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!animate) {
      setDisplay(total);
      return;
    }
    setDisplay(0);
    startRef.current = null;
    let raf: number;

    const cumulatives = values.reduce<number[]>((acc, v, i) => {
      acc.push((acc[i - 1] ?? 0) + v);
      return acc;
    }, []);

    const tickMs = 30;

    function step(ts: number) {
      if (!startRef.current) startRef.current = ts;
      const elapsed = (ts - startRef.current) / 1000;

      let targetTotal = 0;
      let barIndex = 0;
      for (let i = 0; i < popTimes.length; i++) {
        if (elapsed >= (popTimes[i] ?? 0)) {
          targetTotal = cumulatives[i] ?? 0;
          barIndex = i;
        }
      }

      setDisplay((prev) => {
        if (prev >= targetTotal) return targetTotal;
        const barPopTime = popTimes[barIndex] ?? 0;
        const timeSincePop = (elapsed - barPopTime) * 1000;
        const prevCumulative = barIndex > 0 ? (cumulatives[barIndex - 1] ?? 0) : 0;
        const ticksElapsed = Math.floor(timeSincePop / tickMs);
        return Math.min(prevCumulative + ticksElapsed + 1, targetTotal);
      });

      if (targetTotal < total || display < total) {
        raf = requestAnimationFrame(step);
      }
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, total, values, popTimes]);

  return <>{display}</>;
}

// ---------------------------------------------------------------------------
// Stat Card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  accent,
  index,
  href,
}: {
  label: string;
  value: string | number;
  accent?: string;
  index: number;
  href?: string;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();

  const numericValue = typeof value === 'string' ? parseFloat(value) : value;
  const suffix = typeof value === 'string' && value.endsWith('%') ? '%' : '';
  const isNumeric = !isNaN(numericValue);

  const inner = (
    <>
      <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{label}</p>
      <p
        className="mt-2 text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-50"
        style={accent ? { color: accent } : undefined}
      >
        {isInView && isNumeric ? (
          <AnimatedCounter value={numericValue} suffix={suffix} animate={!reducedMotion} />
        ) : (
          value
        )}
      </p>
    </>
  );

  const className = `bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm p-6${href ? ' hover:border-gray-300 dark:hover:border-gray-700 hover:shadow-md transition-all cursor-pointer' : ''}`;

  return href ? (
    <Link href={href}>
      <motion.div
        ref={ref}
        className={className}
        initial={reducedMotion ? false : { opacity: 0, y: 16 }}
        animate={isInView ? { opacity: 1, y: 0 } : undefined}
        transition={{
          duration: 0.5 * SPEED,
          delay: index * 0.08 * SPEED,
          ease: EASE,
        }}
      >
        {inner}
      </motion.div>
    </Link>
  ) : (
    <motion.div
      ref={ref}
      className={className}
      initial={reducedMotion ? false : { opacity: 0, y: 16 }}
      animate={isInView ? { opacity: 1, y: 0 } : undefined}
      transition={{
        duration: 0.5 * SPEED,
        delay: index * 0.08 * SPEED,
        ease: EASE,
      }}
    >
      {inner}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Donut Chart
// ---------------------------------------------------------------------------

function DonutChart({
  title,
  data,
  colors,
  onSegmentClick,
}: {
  title: string;
  data: Record<string, number>;
  colors: Record<string, string>;
  onSegmentClick?: (key: string) => void;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();
  const [tooltip, setTooltip] = useState<{ key: string; value: number; x: number; y: number } | null>(null);

  const entries = Object.entries(data).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);

  const circumference = 2 * Math.PI * 70;

  const segments = useMemo(() => {
    let cum = 0;
    return entries.map(([key, value]) => {
      const fraction = value / total;
      const length = fraction * circumference;
      const offset = -cum;
      cum += length;
      return { key, value, length, offset, color: colors[key] ?? '#94a3b8' };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, total, circumference]);

  const centerCount = useCountUp(
    total,
    800 * SPEED,
    isInView && !reducedMotion,
  );

  if (total === 0) {
    return (
      <Card elevation="raised">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-4">{title}</h3>
        <p className="text-gray-400 dark:text-gray-500 text-center py-8">No data</p>
      </Card>
    );
  }

  return (
    <motion.div
      ref={ref}
      className="bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm p-6"
      initial={reducedMotion ? false : { opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: 0.5 * SPEED, ease: EASE }}
    >
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-4">{title}</h3>
      <div className="flex flex-col items-center">
        <div className="relative">
          <svg viewBox="0 0 200 200" className="w-40 h-40"
            onMouseLeave={() => setTooltip(null)}
          >
          {segments.map((seg, i) => (
            <motion.circle
              key={seg.key}
              cx={100}
              cy={100}
              r={70}
              fill="none"
              stroke={seg.color}
              strokeWidth={28}
              strokeDashoffset={seg.offset}
              transform="rotate(-90 100 100)"
              style={{ cursor: onSegmentClick ? 'pointer' : 'default' }}
              onClick={onSegmentClick ? () => onSegmentClick(seg.key) : undefined}
              onMouseEnter={(e) => {
                const svgEl = (e.target as SVGElement).closest('svg');
                if (!svgEl) return;
                const rect = svgEl.getBoundingClientRect();
                setTooltip({
                  key: seg.key,
                  value: seg.value,
                  x: e.clientX - rect.left,
                  y: e.clientY - rect.top,
                });
              }}
              onMouseMove={(e) => {
                const svgEl = (e.target as SVGElement).closest('svg');
                if (!svgEl) return;
                const rect = svgEl.getBoundingClientRect();
                setTooltip({
                  key: seg.key,
                  value: seg.value,
                  x: e.clientX - rect.left,
                  y: e.clientY - rect.top,
                });
              }}
              onMouseLeave={() => setTooltip(null)}
              initial={
                reducedMotion
                  ? false
                  : { strokeDasharray: `0 ${circumference}` }
              }
              animate={
                isInView
                  ? { strokeDasharray: `${seg.length} ${circumference}` }
                  : undefined
              }
              whileHover={{ strokeWidth: 32 }}
              transition={{
                duration: 0.7 * SPEED,
                delay: i * 0.1 * SPEED,
                ease: 'easeInOut',
              }}
            />
          ))}
          <text
            x={100}
            y={96}
            textAnchor="middle"
            className="fill-gray-900 dark:fill-gray-100"
            fontSize={28}
            fontWeight="bold"
          >
            {centerCount}
          </text>
          <text
            x={100}
            y={116}
            textAnchor="middle"
            className="fill-gray-400 dark:fill-gray-500"
            fontSize={12}
          >
            total
          </text>
        </svg>
          <AnimatePresence>
            {tooltip && (
              <motion.div
                className="absolute pointer-events-none z-10 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs font-medium px-2.5 py-1.5 rounded-lg shadow-lg whitespace-nowrap"
                style={{ left: tooltip.x, top: tooltip.y - 8, transform: 'translate(-50%, -100%)' }}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                {formatLabel(tooltip.key)}: {tooltip.value} ({total > 0 ? Math.round((tooltip.value / total) * 100) : 0}%)
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1">
          {segments.map((seg, i) => (
            <motion.div
              key={seg.key}
              className={`flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-200${onSegmentClick ? ' cursor-pointer hover:text-gray-900 dark:hover:text-gray-50 transition-colors' : ''}`}
              onClick={onSegmentClick ? () => onSegmentClick(seg.key) : undefined}
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={isInView ? { opacity: 1 } : undefined}
              transition={{
                duration: 0.3 * SPEED,
                delay: (segments.length * 0.1 + 0.3 + i * 0.05) * SPEED,
              }}
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: seg.color }}
              />
              {formatLabel(seg.key)} ({seg.value})
            </motion.div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal Bar Chart
// ---------------------------------------------------------------------------

function BarChart({
  title,
  data,
  colors,
  getHref,
}: {
  title: string;
  data: Record<string, number>;
  colors: Record<string, string>;
  getHref?: (key: string) => string;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();

  // Only render statuses that actually have cases — mirrors DonutChart, which
  // filters `v > 0`. Without this, empty lifecycle stages render as blank,
  // label-less bar rows (the "Cases by Status" card looked half-broken).
  const entries = Object.entries(data).filter(([, v]) => v > 0);
  const max = Math.max(...entries.map(([, v]) => v), 1);

  const barDur = 0.5 * BAR_SPEED;
  const valueDur = 0.25 * BAR_SPEED;
  const valuePopTimes = entries.map((_, i) => i * (barDur + valueDur) + barDur);

  // Time when the last bar's +1 counting finishes
  const lastPopTime = valuePopTimes[valuePopTimes.length - 1] ?? 0;
  const lastBarValue = entries[entries.length - 1]?.[1] ?? 0;
  const totalFinishTime = lastPopTime + lastBarValue * 0.03;

  return (
    <motion.div
      ref={ref}
      className="bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm p-6"
      initial={reducedMotion ? false : { opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: 0.5 * SPEED, ease: EASE }}
    >
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
        <motion.span
          className="text-2xl font-bold text-gray-900 dark:text-gray-100 inline-block origin-center"
          initial={reducedMotion ? false : { scale: 1 }}
          animate={
            isInView
              ? { scale: [1, 1, 1.3, 1] }
              : undefined
          }
          transition={{
            duration: 0.4,
            delay: totalFinishTime,
            times: [0, 0, 0.5, 1],
            ease: 'easeOut',
          }}
        >
          <SteppedCounter
            values={entries.map(([, v]) => v)}
            popTimes={valuePopTimes}
            animate={isInView && !reducedMotion}
          />
        </motion.span>
      </div>
      {entries.length === 0 ? (
        <p className="text-gray-400 dark:text-gray-500 text-center py-8">No data</p>
      ) : (
        <div className="space-y-2.5">
          {entries.map(([key, value], i) => {
            const barStart = i * (barDur + valueDur);
            const valueStart = barStart + barDur;

            const href = getHref?.(key);
            const rowInner = (
              <>
                <motion.span
                  className="text-xs text-gray-700 dark:text-gray-200 w-36 text-right flex-shrink-0 truncate"
                  initial={reducedMotion ? false : { opacity: 0, x: -8 }}
                  animate={isInView ? { opacity: 1, x: 0 } : undefined}
                  transition={{
                    duration: 0.25 * BAR_SPEED,
                    delay: barStart,
                  }}
                >
                  {formatLabel(key)}
                </motion.span>
                <div className="flex-1 h-5 bg-surface-base dark:bg-surface-raised rounded-full overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    style={{
                      backgroundColor: colors[key] ?? '#94a3b8',
                      minWidth: value > 0 ? '8px' : '0',
                    }}
                    initial={reducedMotion ? false : { width: 0 }}
                    animate={
                      isInView
                        ? { width: `${(value / max) * 100}%` }
                        : undefined
                    }
                    transition={{
                      duration: barDur,
                      delay: barStart,
                      ease: EASE,
                    }}
                  />
                </div>
                <motion.span
                  className="text-xs font-semibold text-gray-900 dark:text-gray-50 w-8 text-right flex-shrink-0"
                  initial={reducedMotion ? false : { opacity: 0, scale: 0.5 }}
                  animate={isInView ? { opacity: 1, scale: 1 } : undefined}
                  transition={{
                    type: 'spring',
                    stiffness: 500,
                    damping: 20,
                    delay: valueStart,
                  }}
                >
                  {value}
                </motion.span>
              </>
            );

            return href ? (
              <Link
                key={key}
                href={href}
                className="flex items-center gap-3 rounded-lg px-1 -mx-1 hover:bg-surface-base dark:hover:bg-border-subtle/60 transition-colors cursor-pointer"
              >
                {rowInner}
              </Link>
            ) : (
              <div key={key} className="flex items-center gap-3">
                {rowInner}
              </div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

const RANK_COLORS = ['#f59e0b', '#9ca3af', '#b45309'];

function LeaderboardCard({
  title,
  subtitle,
  children,
  index,
  cohort = 'human',
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  index: number;
  cohort?: 'human' | 'system';
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();

  // System cohort gets a muted gray header strip to signal "different cohort"
  // without reinventing the row component. CSS-only treatment.
  const containerClassName =
    cohort === 'system'
      ? 'bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm overflow-hidden'
      : 'bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm p-6';

  return (
    <motion.div
      ref={ref}
      className={containerClassName}
      initial={reducedMotion ? false : { opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: 0.5 * SPEED, delay: index * 0.1 * SPEED, ease: EASE }}
    >
      {cohort === 'system' ? (
        <>
          <div className="bg-gray-100 dark:bg-surface-base/40 px-6 py-3 border-b border-gray-200 dark:border-border-subtle">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{title}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-500 mt-0.5">{subtitle}</p>
          </div>
          <div className="p-6">{children}</div>
        </>
      ) : (
        <>
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 mb-4">{subtitle}</p>
          {children}
        </>
      )}
    </motion.div>
  );
}

function LeaderboardRow({
  rank,
  name,
  primaryStat,
  primaryLabel,
  secondaryStat,
  secondaryLabel,
  index,
  href,
}: {
  rank: number;
  name: string;
  primaryStat: number;
  primaryLabel: string;
  secondaryStat?: number;
  secondaryLabel?: string;
  index: number;
  href?: string;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });
  const reducedMotion = useReducedMotion();
  const rankColor = RANK_COLORS[rank - 1];

  const inner = (
    <>
      <span
        className="text-sm font-bold w-5 flex-shrink-0 text-center"
        style={{ color: rankColor ?? '#6b7280' }}
      >
        {rank}
      </span>
      <span className="flex-1 text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
        {name}
      </span>
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="text-right">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {primaryStat}
          </span>
          <span className="text-[10px] text-gray-400 dark:text-gray-500 ml-1">{primaryLabel}</span>
        </span>
        {secondaryStat !== undefined && secondaryLabel && (
          <span
            className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
            style={{
              backgroundColor:
                secondaryStat >= 80
                  ? 'rgba(34,197,94,0.12)'
                  : secondaryStat >= 50
                    ? 'rgba(234,179,8,0.12)'
                    : 'rgba(239,68,68,0.12)',
              color:
                secondaryStat >= 80 ? '#16a34a' : secondaryStat >= 50 ? '#ca8a04' : '#dc2626',
            }}
          >
            {secondaryStat}% {secondaryLabel}
          </span>
        )}
      </div>
    </>
  );

  const baseClassName = 'flex items-center gap-3 py-2.5 border-b border-gray-100 dark:border-border-subtle last:border-0';
  const hoverClassName = href ? ' rounded-lg px-1 -mx-1 hover:bg-surface-base dark:hover:bg-border-subtle/60 transition-colors cursor-pointer' : '';

  return (
    <motion.div
      ref={ref}
      initial={reducedMotion ? false : { opacity: 0, x: -8 }}
      animate={isInView ? { opacity: 1, x: 0 } : undefined}
      transition={{ duration: 0.35 * SPEED, delay: index * 0.05 * SPEED, ease: EASE }}
    >
      {href ? (
        <Link href={href} className={baseClassName + hoverClassName}>
          {inner}
        </Link>
      ) : (
        <div className={baseClassName}>
          {inner}
        </div>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Repository Bar — custom bar for repos with project label
// ---------------------------------------------------------------------------

function RepoBarChart({
  repos,
}: {
  repos: ObservatoryData['top_repositories'];
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();

  const max = Math.max(...repos.map((r) => r.total_cases), 1);

  const REPO_COLORS = ['#6366f1', '#3b82f6', '#8b5cf6', '#06b6d4', '#10b981'];

  return (
    <motion.div
      ref={ref}
      className="bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm p-6"
      initial={reducedMotion ? false : { opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: 0.5 * SPEED, ease: EASE }}
    >
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1">
        Top Repositories
      </h3>
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">Ranked by case volume</p>
      {repos.length === 0 ? (
        <p className="text-gray-400 dark:text-gray-500 text-center py-8 text-sm">No data</p>
      ) : (
        <div className="space-y-4">
          {repos.map((repo, i) => {
            const barDur = 0.5 * BAR_SPEED;
            const barStart = i * (barDur + 0.15);
            const color = REPO_COLORS[i] ?? '#94a3b8';

            return (
              <div key={repo.repository_id}>
                <div className="flex items-end justify-between mb-1.5 overflow-hidden">
                  <div className="min-w-0 truncate">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {repo.name}
                    </span>
                    {repo.project_name && (
                      <span className="ml-1.5 text-[10px] text-gray-400 dark:text-gray-500">
                        {repo.project_name}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
                    <motion.span
                      className="text-xs font-semibold text-gray-900 dark:text-gray-50"
                      initial={reducedMotion ? false : { opacity: 0 }}
                      animate={isInView ? { opacity: 1 } : undefined}
                      transition={{ duration: 0.3, delay: barStart + barDur }}
                    >
                      {repo.total_cases} case{repo.total_cases !== 1 ? 's' : ''}
                    </motion.span>
                    <span
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                      style={{
                        // #676: decided_count is the terminal-case denominator
                        // behind approval_rate, so a repo with cases but zero
                        // decisions reads neutral, not alarm-red.
                        backgroundColor: approvalRatePillColors(repo.approval_rate, repo.decided_count).bg,
                        color: approvalRatePillColors(repo.approval_rate, repo.decided_count).fg,
                      }}
                    >
                      {repo.approval_rate}% approved
                    </span>
                  </div>
                </div>
                <div className="h-2 bg-surface-base dark:bg-surface-raised rounded-full overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ backgroundColor: color }}
                    initial={reducedMotion ? false : { width: 0 }}
                    animate={isInView ? { width: `${(repo.total_cases / max) * 100}%` } : undefined}
                    transition={{ duration: barDur, delay: barStart, ease: EASE }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Project Overview Cards
// ---------------------------------------------------------------------------

function ProjectOverview({
  projects,
}: {
  projects: ObservatoryData['top_projects'];
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();

  if (projects.length === 0) return null;

  return (
    <div ref={ref}>
      <motion.div
        initial={reducedMotion ? false : { opacity: 0, y: 12 }}
        animate={isInView ? { opacity: 1, y: 0 } : undefined}
        transition={{ duration: 0.4 * SPEED, ease: EASE }}
        className="mb-4"
      >
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-50">
          Project Overview
        </h2>
        <p className="text-sm text-gray-700 dark:text-gray-200 mt-0.5">
          Active projects and their engineering health
        </p>
      </motion.div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project, i) => (
          <Link key={project.project_id} href={`/board?project_id=${project.project_id}&layout=list`}>
            <motion.div
              className="bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm p-5 hover:border-gray-300 dark:hover:border-gray-700 hover:shadow-md transition-all cursor-pointer"
              initial={reducedMotion ? false : { opacity: 0, y: 16 }}
              animate={isInView ? { opacity: 1, y: 0 } : undefined}
              transition={{ duration: 0.4 * SPEED, delay: i * 0.08 * SPEED, ease: EASE }}
            >
              <div className="flex items-start justify-between gap-2 mb-3">
                <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-tight">
                  {project.name}
                </h4>
                <span
                  className="text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{
                    // #676: decided_count is the terminal-case denominator
                    // behind approval_rate, so a project with cases but zero
                    // decisions reads neutral, not alarm-red.
                    backgroundColor: approvalRatePillColors(project.approval_rate, project.decided_count).bg,
                    color: approvalRatePillColors(project.approval_rate, project.decided_count).fg,
                  }}
                >
                  {project.approval_rate}% approved
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                <span>
                  <span className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
                    <AnimatedCounter value={project.total_cases} animate={isInView && !reducedMotion} />
                  </span>{' '}
                  cases
                </span>
                <span>
                  <span className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
                    <AnimatedCounter value={project.team_size} animate={isInView && !reducedMotion} />
                  </span>{' '}
                  contributor{project.team_size !== 1 ? 's' : ''}
                </span>
              </div>
            </motion.div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity Feed
// ---------------------------------------------------------------------------

function ActivityFeed({
  items,
}: {
  items: ObservatoryData['recent_activity'];
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();

  if (items.length === 0) {
    return (
      <Card elevation="raised">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-4">
          Recent Activity
        </h3>
        <p className="text-gray-400 dark:text-gray-500 text-center py-8">No recent activity</p>
      </Card>
    );
  }

  return (
    <motion.div
      ref={ref}
      className="bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm p-6"
      initial={reducedMotion ? false : { opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: 0.5 * SPEED, ease: EASE }}
    >
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-4">
        Recent Activity
      </h3>
      <div className="space-y-0">
        {items.map((item, idx) => {
          const dotColor = ACTIVITY_DOT_COLORS[item.type] ?? '#94a3b8';
          const isLast = idx === items.length - 1;
          return (
            <motion.div
              key={`${item.case_id}-${item.type}-${idx}`}
              className="relative flex gap-3 pb-4"
              initial={reducedMotion ? false : { opacity: 0, y: 12 }}
              animate={isInView ? { opacity: 1, y: 0 } : undefined}
              transition={{
                duration: 0.4 * SPEED,
                delay: idx * 0.06 * SPEED,
                ease: EASE,
              }}
            >
              {/* Timeline connector */}
              {!isLast && (
                <motion.div
                  className="absolute left-[7px] top-4 w-px bg-gray-200 dark:bg-gray-700"
                  initial={reducedMotion ? false : { height: 0 }}
                  animate={
                    isInView
                      ? { height: 'calc(100% - 4px)' }
                      : undefined
                  }
                  transition={{
                    duration: 0.3 * SPEED,
                    delay: (idx * 0.06 + 0.2) * SPEED,
                  }}
                />
              )}
              {/* Dot */}
              <div className="relative flex-shrink-0 mt-1">
                <motion.span
                  className="block w-[15px] h-[15px] rounded-full border-2 border-white dark:border-gray-900"
                  style={{ backgroundColor: dotColor }}
                  initial={reducedMotion ? false : { scale: 0 }}
                  animate={isInView ? { scale: 1 } : undefined}
                  transition={{
                    type: 'spring',
                    stiffness: 400,
                    damping: 15,
                    delay: idx * 0.06 * SPEED,
                  }}
                />
              </div>
              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {item.case_title}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 flex-shrink-0">
                    {formatLabel(item.type)}
                  </span>
                  <RelativeTime
                    timestamp={item.created_at}
                    className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0 ml-auto"
                  />
                </div>
                <p className="text-xs text-gray-700 dark:text-gray-200 mt-0.5 truncate">
                  {item.summary}
                </p>
              </div>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Throughput Leaderboard
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return '< 1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const remMins = mins % 60;
    return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function ThroughputLeaderboard({
  items,
}: {
  items: ObservatoryData['throughput_leaderboard'];
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });
  const reducedMotion = useReducedMotion();

  if (items.length === 0) return null;

  const maxDuration = Math.max(...items.map((i) => i.duration_ms), 1);

  return (
    <div ref={ref}>
      <motion.div
        initial={reducedMotion ? false : { opacity: 0, y: 12 }}
        animate={isInView ? { opacity: 1, y: 0 } : undefined}
        transition={{ duration: 0.4 * SPEED, ease: EASE }}
        className="mb-4"
      >
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-50">
          Throughput Leaderboard
        </h2>
        <p className="text-sm text-gray-700 dark:text-gray-200 mt-0.5">
          Cases ranked by cycle time — completed cases first, fastest to slowest
        </p>
      </motion.div>

      <motion.div
        className="bg-surface-raised rounded-lg border border-gray-200 dark:border-border-subtle shadow-sm p-6"
        initial={reducedMotion ? false : { opacity: 0, y: 20 }}
        animate={isInView ? { opacity: 1, y: 0 } : undefined}
        transition={{ duration: 0.5 * SPEED, ease: EASE }}
      >
        <div className="space-y-0">
          {items.map((item, i) => {
            const barWidth = (item.duration_ms / maxDuration) * 100;
            const barColor = item.is_completed
              ? item.status === 'rejected'
                ? '#ef4444'
                : '#22c55e'
              : '#6366f1';
            const rankColor = RANK_COLORS[i] ?? '#6b7280';
            const statusColor = STATUS_COLORS[item.status] ?? '#94a3b8';
            const riskColor = RISK_COLORS[item.risk_level] ?? '#94a3b8';
            const barDelay = i * 0.07 * BAR_SPEED;

            return (
              <motion.div
                key={item.case_id}
                className="border-b border-gray-100 dark:border-border-subtle last:border-0"
                initial={reducedMotion ? false : { opacity: 0, x: -8 }}
                animate={isInView ? { opacity: 1, x: 0 } : undefined}
                transition={{ duration: 0.35 * SPEED, delay: i * 0.05 * SPEED, ease: EASE }}
              >
                <Link
                  href={`/cases/${item.case_id}`}
                  className="block py-3 px-2 -mx-2 rounded-lg hover:bg-surface-base dark:hover:bg-border-subtle/60 transition-colors"
                >
                  {/* Top row: rank, title, badges, duration */}
                  <div className="flex items-center gap-3 mb-2">
                    <span
                      className="text-sm font-bold w-5 flex-shrink-0 text-center"
                      style={{ color: rankColor }}
                    >
                      {i + 1}
                    </span>
                    <span className="flex-1 text-sm font-medium text-gray-800 dark:text-gray-200 truncate min-w-0">
                      {item.title}
                    </span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span
                        className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                        style={{
                          backgroundColor: `${statusColor}1a`,
                          color: statusColor,
                        }}
                      >
                        {formatLabel(item.status)}
                      </span>
                      <span
                        className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                        style={{
                          backgroundColor: `${riskColor}1a`,
                          color: riskColor,
                        }}
                      >
                        {item.risk_level}
                      </span>
                      <span
                        className="text-xs font-semibold tabular-nums w-16 text-right"
                        style={{ color: barColor }}
                      >
                        {item.is_completed ? '' : '~'}{formatDuration(item.duration_ms)}
                      </span>
                    </div>
                  </div>
                  {/* Duration bar */}
                  <div className="ml-8 h-1.5 bg-surface-base dark:bg-surface-raised rounded-full overflow-hidden">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ backgroundColor: barColor }}
                      initial={reducedMotion ? false : { width: 0 }}
                      animate={isInView ? { width: `${barWidth}%` } : undefined}
                      transition={{ duration: 0.5 * BAR_SPEED, delay: barDelay, ease: EASE }}
                    />
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading Spinner
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <svg
        className="animate-spin h-8 w-8 text-accent"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx={12}
          cy={12}
          r={10}
          stroke="currentColor"
          strokeWidth={4}
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ObservatoryPage() {
  const router = useRouter();
  const [data, setData] = useState<ObservatoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>(DATE_RANGES[DATE_RANGES.length - 1]!);
  const reducedMotion = useReducedMotion();

  const loadData = useCallback(async (days: number | null) => {
    setLoading(true);
    try {
      const res = await api.observatory.get(days ? { days } : undefined);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load observatory data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(dateRange.days);
  }, [dateRange, loadData]);

  if (loading) return <Spinner />;

  if (error || !data) {
    return (
      <div className="max-w-7xl mx-auto px-4 md:px-6 py-8">
        <p className="text-red-500 dark:text-red-400">{error ?? 'Unknown error'}</p>
      </div>
    );
  }

  const {
    summary,
    cases_by_status,
    risk_distribution,
    findings_by_severity,
    track_distribution,
    recent_activity,
    top_contributors,
    top_reviewers,
    top_repositories,
    top_projects,
    throughput_leaderboard,
    top_referenced_assets,
  } = data;

  // Decided = terminal cases (approved + rejected + done) — the exact
  // denominator behind `summary.approval_rate`. `0` means no case has been
  // decided yet (brand-new / empty workspace), so a 0% rate reads as "no data"
  // (neutral) rather than alarm-red for a stalled pipeline. See #664.
  const decidedCount =
    (cases_by_status['approved'] ?? 0) +
    (cases_by_status['rejected'] ?? 0) +
    (cases_by_status['done'] ?? 0);

  // Split contributors and reviewers into human / system cohorts. Server returns them already sorted by
  // primary metric desc, so the post-split order is the rank order. Re-ranking is implicit via the
  // map-index in the render loop below.
  const { human: humanContributors, system: systemContributors } =
    splitActorRows(top_contributors);
  const { human: humanReviewers, system: systemReviewers } =
    splitActorRows(top_reviewers);

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-8">
      {/* Header */}
      <motion.div
        className="mb-8 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4"
        initial={reducedMotion ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 * SPEED, ease: EASE }}
      >
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-50">Observatory</h1>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">
            Engineering metrics and activity overview
          </p>
        </div>
        <div className="flex items-center gap-1 bg-surface-base dark:bg-surface-raised rounded-lg p-1">
          {DATE_RANGES.map((range) => (
            <button
              key={range.label}
              onClick={() => setDateRange(range)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                dateRange.label === range.label
                  ? 'bg-surface-raised text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
      </motion.div>

      {/* Row 1: Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Total Cases" value={summary.total_cases} index={0} href="/board" />
        <StatCard label="Pending Review" value={summary.pending_reviews} accent="#f97316" index={1} href="/board?status=in_review&layout=list" />
        <StatCard label="Approval Rate" value={`${summary.approval_rate}%`} accent={approvalRateStatAccent(summary.approval_rate, decidedCount)} index={2} href="/board?status=approved&layout=list" />
        <StatCard label="Total Findings" value={summary.total_findings} index={3} href="/board?layout=list" />
        <StatCard label={dateRange.days !== null ? 'Knowledge Assets (all time)' : 'Knowledge Assets'} value={summary.total_knowledge_assets} accent="#6366f1" index={4} href="/knowledge" />
      </div>

      {/* Row 2: Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
        <BarChart
          title="Cases by Status"
          data={sortByLifecycle(cases_by_status)}
          colors={STATUS_COLORS}
          getHref={(status) => `/board?status=${status}&layout=list`}
        />
        <DonutChart
          title="Risk Distribution"
          data={risk_distribution}
          colors={RISK_COLORS}
          onSegmentClick={(key) => router.push(`/board?risk_level=${key}`)}
        />
        <DonutChart title="Findings by Severity" data={findings_by_severity} colors={SEVERITY_COLORS} />
        <DonutChart
          title="Validation Track"
          data={track_distribution}
          colors={TRACK_COLORS}
          onSegmentClick={(key) => router.push(`/board?validation_track=${key}`)}
        />
      </div>

      {/* Row 3: Leaderboards + Repo Activity */}
      <div className="mt-10">
        <motion.div
          className="mb-4"
          initial={reducedMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 * SPEED, ease: EASE }}
        >
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-50">
            Team & Repository Activity
          </h2>
          <p className="text-sm text-gray-700 dark:text-gray-200 mt-0.5">
            Who is shipping, who is reviewing, and where the work lives
          </p>
        </motion.div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Top Contributors — human cohort only (system actors split into
              dedicated section below). */}
          <LeaderboardCard title="Top Contributors" subtitle="Ranked by case ownership" index={0}>
            {humanContributors.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4 px-2 leading-relaxed">
                No cases yet.
                <br />
                Contributors will appear here as cases are created.
              </p>
            ) : (
              humanContributors.map((contributor, i) => (
                <LeaderboardRow
                  key={contributor.user_id}
                  rank={i + 1}
                  name={contributor.display_name}
                  primaryStat={contributor.total_cases}
                  primaryLabel="cases"
                  secondaryStat={contributor.approval_rate}
                  secondaryLabel="approved"
                  index={i}
                  href={`/board?owner_user_id=${contributor.user_id}&layout=list`}
                />
              ))
            )}
          </LeaderboardCard>

          {/* Top Reviewers — human cohort only. */}
          <LeaderboardCard title="Top Reviewers" subtitle="Cases assigned for review" index={1}>
            {humanReviewers.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4 px-2 leading-relaxed">
                No human reviews yet.
                <br />
                Reviewers will appear here once decisions are filed manually.
              </p>
            ) : (
              humanReviewers.map((reviewer, i) => (
                <LeaderboardRow
                  key={reviewer.user_id}
                  rank={i + 1}
                  name={reviewer.display_name}
                  primaryStat={reviewer.cases_reviewed}
                  primaryLabel="reviewed"
                  index={i}
                  href={`/board?owner_user_id=${reviewer.user_id}&layout=list`}
                />
              ))
            )}
          </LeaderboardCard>

          {/* Top Repositories */}
          <RepoBarChart repos={top_repositories} />
        </div>

        {/* System activity — automated decisions, webhook activity, and
            other non-human actors. Default-expanded; not a
            collapsible toggle in v1. Renders directly below the human
            leaderboards on the same scroll surface. */}
        <div className="mt-6">
          <motion.div
            className="mb-3"
            initial={reducedMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 * SPEED, ease: EASE }}
          >
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              System activity
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Automated decisions, webhook activity, and other non-human actors.
            </p>
          </motion.div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <LeaderboardCard
              title="System Contributors"
              subtitle="Automated case ownership"
              index={0}
              cohort="system"
            >
              {systemContributors.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4 px-2 leading-relaxed">
                  No system activity in this period.
                </p>
              ) : (
                systemContributors.map((contributor, i) => (
                  <LeaderboardRow
                    key={contributor.user_id}
                    rank={i + 1}
                    name={contributor.display_name}
                    primaryStat={contributor.total_cases}
                    primaryLabel="cases"
                    secondaryStat={contributor.approval_rate}
                    secondaryLabel="approved"
                    index={i}
                    href={`/board?owner_user_id=${contributor.user_id}&layout=list`}
                  />
                ))
              )}
            </LeaderboardCard>

            <LeaderboardCard
              title="System Reviewers"
              subtitle="Auto-approves and automated decisions"
              index={1}
              cohort="system"
            >
              {systemReviewers.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4 px-2 leading-relaxed">
                  No system activity in this period.
                </p>
              ) : (
                systemReviewers.map((reviewer, i) => (
                  <LeaderboardRow
                    key={reviewer.user_id}
                    rank={i + 1}
                    name={reviewer.display_name}
                    primaryStat={reviewer.cases_reviewed}
                    primaryLabel="reviewed"
                    index={i}
                    href={`/board?owner_user_id=${reviewer.user_id}&layout=list`}
                  />
                ))
              )}
            </LeaderboardCard>
          </div>
        </div>
      </div>

      {/* Row 4: Project Overview */}
      {top_projects.length > 0 && (
        <div className="mt-10">
          <ProjectOverview projects={top_projects} />
        </div>
      )}

      {/* Row 4.5: Most Referenced Knowledge Assets */}
      <div className="mt-10">
        <motion.div
          className="mb-4"
          initial={reducedMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 * SPEED, ease: EASE }}
        >
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-50">
            Knowledge Usage
          </h2>
          <p className="text-sm text-gray-700 dark:text-gray-200 mt-0.5">
            Which assets are being attached to cases that produce decisions
          </p>
        </motion.div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <LeaderboardCard
            title="Most Referenced Assets"
            subtitle="Ranked by cases attaching them"
            index={0}
          >
            {top_referenced_assets.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">
                No knowledge assets referenced yet — decisions will populate this as cases attach
                assets.
              </p>
            ) : (
              top_referenced_assets.map((asset, i) => (
                <LeaderboardRow
                  key={asset.knowledge_id}
                  rank={i + 1}
                  name={asset.title}
                  primaryStat={asset.reference_count}
                  primaryLabel={formatLabel(asset.type)}
                  index={i}
                  href="/knowledge"
                />
              ))
            )}
          </LeaderboardCard>
        </div>
      </div>

      {/* Row 5: Throughput Leaderboard */}
      {throughput_leaderboard.length > 0 && (
        <div className="mt-10">
          <ThroughputLeaderboard items={throughput_leaderboard} />
        </div>
      )}

      {/* Row 6: Activity Feed */}
      <div className="mt-10">
        <ActivityFeed items={recent_activity} />
      </div>
    </div>
  );
}
