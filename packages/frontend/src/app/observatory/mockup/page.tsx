'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';

// ---------------------------------------------------------------------------
// Timing config (adjustable via controls)
// ---------------------------------------------------------------------------

type Easing = 'easeOut' | 'easeInOut' | 'anticipate';

const EASING_OPTIONS: Easing[] = ['easeOut', 'easeInOut', 'anticipate'];

// ---------------------------------------------------------------------------
// useCountUp — returns an animated number (for use in SVG text or anywhere)
// ---------------------------------------------------------------------------

function useCountUp(
  target: number,
  duration: number,
  speedMultiplier: number,
  animate: boolean,
) {
  const [display, setDisplay] = useState(animate ? 0 : target);

  useEffect(() => {
    if (!animate) {
      setDisplay(target);
      return;
    }
    const ms = duration * speedMultiplier;
    let start: number | null = null;
    let raf: number;

    function step(ts: number) {
      if (!start) start = ts;
      const progress = Math.min((ts - start) / ms, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(eased * target));
      if (progress < 1) {
        raf = requestAnimationFrame(step);
      }
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, speedMultiplier, animate]);

  return display;
}

// ---------------------------------------------------------------------------
// AnimatedCounter — counts from 0 to target
// ---------------------------------------------------------------------------

function AnimatedCounter({
  value,
  duration = 800,
  suffix = '',
  speedMultiplier = 1,
  animate = true,
}: {
  value: number;
  duration?: number;
  suffix?: string;
  speedMultiplier?: number;
  animate?: boolean;
}) {
  const [display, setDisplay] = useState(animate ? 0 : value);

  useEffect(() => {
    if (!animate) {
      setDisplay(value);
      return;
    }
    const ms = duration * speedMultiplier;
    let start: number | null = null;
    let raf: number;

    function step(ts: number) {
      if (!start) start = ts;
      const progress = Math.min((ts - start) / ms, 1);
      // easeOut curve
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(eased * value));
      if (progress < 1) {
        raf = requestAnimationFrame(step);
      }
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, speedMultiplier, animate]);

  return (
    <span>
      {display}
      {suffix}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SteppedCounter — total that increments as each bar value pops in
// ---------------------------------------------------------------------------

function SteppedCounter({
  values,
  popTimes,
  animate,
  resetKey,
}: {
  values: number[];
  popTimes: number[]; // seconds after inView when each value pops
  animate: boolean;
  resetKey: number;
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

    // Build cumulative sums at each pop time
    const cumulatives = values.reduce<number[]>((acc, v, i) => {
      acc.push((acc[i - 1] ?? 0) + v);
      return acc;
    }, []);

    // Time to count up each bar's value (+1 at a time): 30ms per tick
    const tickMs = 30;

    function step(ts: number) {
      if (!startRef.current) startRef.current = ts;
      const elapsed = (ts - startRef.current) / 1000; // seconds

      // Find the target total based on which bars have popped,
      // then smoothly count +1 towards it
      let targetTotal = 0;
      for (let i = 0; i < popTimes.length; i++) {
        if (elapsed >= (popTimes[i] ?? 0)) {
          targetTotal = cumulatives[i] ?? 0;
        }
      }

      // For the currently counting segment, interpolate +1 per tick
      setDisplay((prev) => {
        if (prev >= targetTotal) return targetTotal;
        // How many ticks have passed since the last bar popped?
        // Find which bar we're counting through
        let barIndex = 0;
        for (let i = 0; i < popTimes.length; i++) {
          if (elapsed >= (popTimes[i] ?? 0)) barIndex = i;
        }
        const barPopTime = popTimes[barIndex] ?? 0;
        const timeSincePop = (elapsed - barPopTime) * 1000; // ms
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
  }, [animate, resetKey, total, values, popTimes]);

  return <>{display}</>;
}

// ---------------------------------------------------------------------------
// Section wrapper — viewport-triggered fade+slide
// ---------------------------------------------------------------------------

function RevealSection({
  children,
  className = '',
  delay = 0,
  speedMultiplier = 1,
  easing = 'easeOut' as Easing,
  resetKey = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  speedMultiplier?: number;
  easing?: Easing;
  resetKey?: number;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      key={resetKey}
      ref={ref}
      initial={reducedMotion ? false : { opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : undefined}
      transition={{
        duration: 0.5 * speedMultiplier,
        delay: delay * speedMultiplier,
        ease: easing,
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Demo: Stat Cards
// ---------------------------------------------------------------------------

function DemoStatCards({
  speedMultiplier,
  easing,
  resetKey,
}: {
  speedMultiplier: number;
  easing: Easing;
  resetKey: number;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();

  const cards = [
    { label: 'Total Cases', value: 42 },
    { label: 'Pending Review', value: 7, accent: '#f97316' },
    { label: 'Approval Rate', value: 72, suffix: '%', accent: '#22c55e' },
    { label: 'Total Findings', value: 156 },
  ];

  return (
    <div ref={ref} className="grid grid-cols-2 lg:grid-cols-4 gap-4" key={resetKey}>
      {cards.map((card, i) => (
        <motion.div
          key={`${card.label}-${resetKey}`}
          initial={reducedMotion ? false : { opacity: 0, y: 16 }}
          animate={isInView ? { opacity: 1, y: 0 } : undefined}
          transition={{
            duration: 0.5 * speedMultiplier,
            delay: i * 0.08 * speedMultiplier,
            ease: easing,
          }}
          className="bg-surface-raised rounded-xl border border-gray-200 dark:border-border-subtle shadow-sm p-6"
        >
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
            {card.label}
          </p>
          <p
            className="mt-2 text-3xl font-bold tracking-tight"
            style={card.accent ? { color: card.accent } : undefined}
          >
            {isInView ? (
              <AnimatedCounter
                value={card.value}
                suffix={card.suffix}
                duration={800}
                speedMultiplier={speedMultiplier}
                animate={!reducedMotion}
              />
            ) : (
              <>0{card.suffix ?? ''}</>
            )}
          </p>
        </motion.div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo: Bar Chart
// ---------------------------------------------------------------------------

const BAR_DATA = [
  { label: 'Open', value: 5, color: '#6b7280' },
  { label: 'Exploration', value: 8, color: '#3b82f6' },
  { label: 'In Build', value: 12, color: '#6366f1' },
  { label: 'In Validation', value: 4, color: '#a855f7' },
  { label: 'In Review', value: 7, color: '#f59e0b' },
  { label: 'Approved', value: 3, color: '#22c55e' },
  { label: 'Done', value: 2, color: '#10b981' },
  { label: 'Rejected', value: 1, color: '#ef4444' },
];

function DemoBarChart({
  speedMultiplier,
  easing,
  resetKey,
}: {
  speedMultiplier: number;
  easing: Easing;
  resetKey: number;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();
  const max = Math.max(...BAR_DATA.map((d) => d.value));
  // Bar chart runs at 75% of the global speed multiplier (a bit faster)
  const barSpeed = speedMultiplier * 0.75;

  // Build cumulative totals for the stepped counter
  const barDur = 0.5 * barSpeed;
  const valueDur = 0.25 * barSpeed;
  const valuePopTimes = BAR_DATA.map((_, i) => i * (barDur + valueDur) + barDur);

  // Time when the last bar's +1 counting finishes (last pop + ticks for last value)
  const lastPopTime = valuePopTimes[valuePopTimes.length - 1] ?? 0;
  const lastBarValue = BAR_DATA[BAR_DATA.length - 1]?.value ?? 0;
  const totalFinishTime = lastPopTime + (lastBarValue * 0.03); // 30ms per tick

  return (
    <RevealSection speedMultiplier={speedMultiplier} easing={easing} resetKey={resetKey}>
      <div
        ref={ref}
        className="bg-surface-raised rounded-xl border border-gray-200 dark:border-border-subtle shadow-sm p-6"
      >
        <div className="flex items-baseline justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Cases by Status
          </h3>
          <motion.span
            key={`total-pop-${resetKey}`}
            className="text-2xl font-bold text-gray-900 dark:text-gray-100 inline-block origin-center"
            initial={reducedMotion ? false : { scale: 1 }}
            animate={
              isInView
                ? {
                    scale: [1, 1, 1.3, 1],
                  }
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
              values={BAR_DATA.map((d) => d.value)}
              popTimes={valuePopTimes}
              animate={isInView && !reducedMotion}
              resetKey={resetKey}
            />
          </motion.span>
        </div>
        <div className="space-y-2.5">
          {BAR_DATA.map((bar, i) => {
            // Sequential: each bar takes barDur to grow, then valueDur for the value pop,
            // then the next bar starts. Total per bar = barDur + valueDur.
            const barStart = i * (barDur + valueDur);
            const valueStart = barStart + barDur;

            return (
              <div key={`${bar.label}-${resetKey}`} className="flex items-center gap-3">
                <motion.span
                  className="text-xs text-gray-600 dark:text-gray-400 w-28 text-right flex-shrink-0"
                  initial={reducedMotion ? false : { opacity: 0, x: -8 }}
                  animate={isInView ? { opacity: 1, x: 0 } : undefined}
                  transition={{
                    duration: 0.25 * barSpeed,
                    delay: barStart,
                  }}
                >
                  {bar.label}
                </motion.span>
                <div className="flex-1 h-5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ backgroundColor: bar.color }}
                    initial={reducedMotion ? false : { width: 0 }}
                    animate={
                      isInView
                        ? { width: `${(bar.value / max) * 100}%` }
                        : undefined
                    }
                    transition={{
                      duration: barDur,
                      delay: barStart,
                      ease: easing,
                    }}
                  />
                </div>
                <motion.span
                  className="text-xs font-semibold text-gray-700 dark:text-gray-300 w-8 text-right flex-shrink-0"
                  initial={reducedMotion ? false : { opacity: 0, scale: 0.5 }}
                  animate={isInView ? { opacity: 1, scale: 1 } : undefined}
                  transition={{
                    type: 'spring',
                    stiffness: 500,
                    damping: 20,
                    delay: valueStart,
                  }}
                >
                  {bar.value}
                </motion.span>
              </div>
            );
          })}
        </div>
      </div>
    </RevealSection>
  );
}

// ---------------------------------------------------------------------------
// Demo: Donut Chart
// ---------------------------------------------------------------------------

const DONUT_DATA = [
  { label: 'Low', value: 18, color: '#22c55e' },
  { label: 'Medium', value: 12, color: '#eab308' },
  { label: 'High', value: 8, color: '#f97316' },
  { label: 'Critical', value: 4, color: '#ef4444' },
];

function DemoDonutChart({
  speedMultiplier,
  easing,
  resetKey,
}: {
  speedMultiplier: number;
  easing: Easing;
  resetKey: number;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();

  const total = DONUT_DATA.reduce((s, d) => s + d.value, 0);
  const circumference = 2 * Math.PI * 70;

  const segments = useMemo(() => {
    let cum = 0;
    return DONUT_DATA.map((d) => {
      const fraction = d.value / total;
      const length = fraction * circumference;
      const offset = -cum;
      cum += length;
      return { ...d, length, offset };
    });
  }, [total, circumference]);

  const centerCount = useCountUp(
    total,
    800,
    speedMultiplier,
    isInView && !reducedMotion,
  );

  return (
    <RevealSection speedMultiplier={speedMultiplier} easing={easing} resetKey={resetKey}>
      <div
        ref={ref}
        className="bg-surface-raised rounded-xl border border-gray-200 dark:border-border-subtle shadow-sm p-6"
      >
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
          Risk Distribution
        </h3>
        <div className="flex flex-col items-center">
          <svg viewBox="0 0 200 200" className="w-40 h-40">
            {segments.map((seg, i) => (
              <motion.circle
                key={`${seg.label}-${resetKey}`}
                cx={100}
                cy={100}
                r={70}
                fill="none"
                stroke={seg.color}
                strokeWidth={28}
                strokeDashoffset={seg.offset}
                transform="rotate(-90 100 100)"
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
                transition={{
                  duration: 0.7 * speedMultiplier,
                  delay: i * 0.1 * speedMultiplier,
                  ease: easing,
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
          <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1">
            {segments.map((seg, i) => (
              <motion.div
                key={`legend-${seg.label}-${resetKey}`}
                className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400"
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={isInView ? { opacity: 1 } : undefined}
                transition={{
                  duration: 0.3 * speedMultiplier,
                  delay: (segments.length * 0.1 + 0.3 + i * 0.05) * speedMultiplier,
                }}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: seg.color }}
                />
                {seg.label} ({seg.value})
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </RevealSection>
  );
}

// ---------------------------------------------------------------------------
// Demo: Activity Feed
// ---------------------------------------------------------------------------

const ACTIVITY_DATA = [
  {
    title: 'Implement OAuth flow',
    type: 'review_run',
    summary: 'LLM review completed — 3 findings detected',
    time: '5m ago',
    dotColor: '#f59e0b',
  },
  {
    title: 'Update user settings API',
    type: 'rule_run',
    summary: 'All 12 rules passed',
    time: '23m ago',
    dotColor: '#a855f7',
  },
  {
    title: 'Add dark mode toggle',
    type: 'case_created',
    summary: 'New case created from PR #147',
    time: '1h ago',
    dotColor: '#6366f1',
  },
  {
    title: 'Fix pagination bug',
    type: 'evidence_collection_run',
    summary: 'CI pipeline passed — evidence collected',
    time: '2h ago',
    dotColor: '#10b981',
  },
];

function DemoActivityFeed({
  speedMultiplier,
  easing,
  resetKey,
}: {
  speedMultiplier: number;
  easing: Easing;
  resetKey: number;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();

  return (
    <RevealSection speedMultiplier={speedMultiplier} easing={easing} resetKey={resetKey}>
      <div
        ref={ref}
        className="bg-surface-raised rounded-xl border border-gray-200 dark:border-border-subtle shadow-sm p-6"
      >
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
          Recent Activity
        </h3>
        <div className="space-y-0">
          {ACTIVITY_DATA.map((item, idx) => {
            const isLast = idx === ACTIVITY_DATA.length - 1;
            return (
              <motion.div
                key={`${item.title}-${resetKey}`}
                className="relative flex gap-3 pb-4"
                initial={reducedMotion ? false : { opacity: 0, y: 12 }}
                animate={isInView ? { opacity: 1, y: 0 } : undefined}
                transition={{
                  duration: 0.4 * speedMultiplier,
                  delay: idx * 0.06 * speedMultiplier,
                  ease: easing,
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
                      duration: 0.3 * speedMultiplier,
                      delay: (idx * 0.06 + 0.2) * speedMultiplier,
                    }}
                  />
                )}
                {/* Dot */}
                <div className="relative flex-shrink-0 mt-1">
                  <motion.span
                    className="block w-[15px] h-[15px] rounded-full border-2 border-white dark:border-gray-900"
                    style={{ backgroundColor: item.dotColor }}
                    initial={reducedMotion ? false : { scale: 0 }}
                    animate={isInView ? { scale: 1 } : undefined}
                    transition={{
                      type: 'spring',
                      stiffness: 400,
                      damping: 15,
                      delay: idx * 0.06 * speedMultiplier,
                    }}
                  />
                </div>
                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {item.title}
                    </span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 flex-shrink-0">
                      {item.type.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0 ml-auto">
                      {item.time}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                    {item.summary}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </RevealSection>
  );
}

// ---------------------------------------------------------------------------
// Mockup Page
// ---------------------------------------------------------------------------

export default function ObservatoryMockupPage() {
  const [speed, setSpeed] = useState(1);
  const [easing, setEasing] = useState<Easing>('easeOut');
  const [resetKey, setResetKey] = useState(0);

  const handleReset = useCallback(() => {
    setResetKey((k) => k + 1);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  return (
    <div className="max-w-4xl mx-auto p-6">
      {/* Controls */}
      <div className="sticky top-0 z-50 bg-surface-raised/90 backdrop-blur-sm border border-gray-200 dark:border-border-subtle rounded-xl p-4 mb-8 shadow-lg">
        <div className="flex items-center gap-6 flex-wrap">
          <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">
            Animation Mockup
          </h2>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Speed:</span>
            {[0.5, 1, 2].map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`px-2 py-1 text-xs rounded ${
                  speed === s
                    ? 'bg-accent-700 text-white'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                }`}
              >
                {s}x {s === 0.5 ? '(fast)' : s === 2 ? '(slow)' : ''}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Easing:</span>
            {EASING_OPTIONS.map((e) => (
              <button
                key={e}
                onClick={() => setEasing(e)}
                className={`px-2 py-1 text-xs rounded ${
                  easing === e
                    ? 'bg-accent-700 text-white'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                }`}
              >
                {e}
              </button>
            ))}
          </div>

          <button
            onClick={handleReset}
            className="px-3 py-1 text-xs rounded bg-red-500 text-white hover:bg-red-600 transition-colors ml-auto"
          >
            Reset All
          </button>
        </div>
      </div>

      {/* Section 1: Stat Cards (above fold) */}
      <div className="mb-4">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-2">
          Stat Cards
        </h2>
        <p className="text-xs text-gray-400 mb-4">
          Fade-in + slide-up with staggered counter animation
        </p>
      </div>
      <DemoStatCards
        key={`stats-${resetKey}`}
        speedMultiplier={speed}
        easing={easing}
        resetKey={resetKey}
      />

      {/* Spacer */}
      <div className="h-[60vh] flex items-center justify-center">
        <p className="text-gray-300 dark:text-gray-700 text-sm">
          Scroll down for bar chart...
        </p>
      </div>

      {/* Section 2: Bar Chart */}
      <div className="mb-4">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-2">
          Bar Chart
        </h2>
        <p className="text-xs text-gray-400 mb-4">
          Bars grow from 0 width, staggered. Value labels fade in after bar completes.
        </p>
      </div>
      <DemoBarChart
        key={`bars-${resetKey}`}
        speedMultiplier={speed}
        easing={easing}
        resetKey={resetKey}
      />

      {/* Spacer */}
      <div className="h-[60vh] flex items-center justify-center">
        <p className="text-gray-300 dark:text-gray-700 text-sm">
          Scroll down for donut chart...
        </p>
      </div>

      {/* Section 3: Donut Chart */}
      <div className="mb-4">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-2">
          Donut Chart
        </h2>
        <p className="text-xs text-gray-400 mb-4">
          Segments sweep in sequentially. Center counter + legend fade in after.
        </p>
      </div>
      <DemoDonutChart
        key={`donut-${resetKey}`}
        speedMultiplier={speed}
        easing={easing}
        resetKey={resetKey}
      />

      {/* Spacer */}
      <div className="h-[60vh] flex items-center justify-center">
        <p className="text-gray-300 dark:text-gray-700 text-sm">
          Scroll down for activity feed...
        </p>
      </div>

      {/* Section 4: Activity Feed */}
      <div className="mb-4">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-2">
          Activity Feed
        </h2>
        <p className="text-xs text-gray-400 mb-4">
          Items cascade in. Dots pop with spring. Timeline lines draw downward.
        </p>
      </div>
      <DemoActivityFeed
        key={`feed-${resetKey}`}
        speedMultiplier={speed}
        easing={easing}
        resetKey={resetKey}
      />

      {/* Bottom spacer */}
      <div className="h-32" />
    </div>
  );
}
