'use client';

import { motion } from 'framer-motion';

interface LauncherTileProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  badge?: number;
  highlighted?: boolean;
  onClick: () => void;
}

export function LauncherTile({ icon, label, description, badge, highlighted, onClick }: LauncherTileProps) {
  const hasBadge = badge !== undefined && badge > 0;
  const isHighlighted = highlighted && hasBadge;

  return (
    <motion.button
      onClick={onClick}
      className="group relative outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-2xl"
      aria-label={hasBadge ? `${label} — ${badge} items need attention` : label}
      variants={{
        hidden: { scale: 0.9, opacity: 0, y: 20 },
        visible: { scale: 1, opacity: 1, y: 0 },
        exit: { scale: 0.85, opacity: 0, y: -10 },
      }}
    >
      {/* Gradient border wrapper */}
      <div
        className={`
          absolute -inset-[1px] rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300
          bg-gradient-to-br from-accent-400/60 via-accent/20 to-accent/60
          dark:from-accent-300/50 dark:via-accent/10 dark:to-accent-400/50
          ${isHighlighted ? '!opacity-100 from-accent-400/60 via-accent-300/20 to-accent-500/60 dark:from-accent-400/50 dark:via-accent-300/10 dark:to-accent-500/50' : ''}
        `}
      />

      {/* Inner card */}
      <div
        className={`
          relative flex flex-col items-center justify-center rounded-2xl p-6 md:p-8
          cursor-pointer text-center
          bg-surface-raised/50 dark:bg-surface-raised/40 backdrop-blur-lg
          border border-white/20 dark:border-white/5
          shadow-xl shadow-black/8 dark:shadow-black/40
          group-hover:bg-white/70 dark:group-hover:bg-gray-800/50
          group-hover:shadow-2xl group-hover:shadow-black/12 dark:group-hover:shadow-black/50
          transition-all duration-300
          ${isHighlighted ? 'animate-pulse-glow' : ''}
        `}
      >
        {/* Badge */}
        {hasBadge && (
          <span className="absolute -top-2.5 -right-2.5 z-10 inline-flex items-center justify-center rounded-full bg-accent-700 px-2.5 py-0.5 text-xs font-bold text-white shadow-md shadow-accent/30 min-w-[1.5rem]">
            {badge}
          </span>
        )}

        {/* Icon — larger with subtle glow on hover */}
        <span
          className={`
            h-10 w-10 md:h-12 md:w-12 transition-all duration-300
            ${isHighlighted
              ? 'text-accent dark:text-accent-400 group-hover:text-accent-hover dark:group-hover:text-accent-300'
              : 'text-accent-500 dark:text-accent-400 group-hover:text-accent-600 dark:group-hover:text-accent-300'
            }
            group-hover:scale-110 group-hover:drop-shadow-[0_0_8px_rgba(234,88,12,0.3)]
            dark:group-hover:drop-shadow-[0_0_8px_rgba(234,88,12,0.3)]
          `}
        >
          {icon}
        </span>

        {/* Label */}
        <span className="mt-3 text-base md:text-lg font-semibold text-gray-900 dark:text-gray-100">
          {label}
        </span>

        {/* Description */}
        <span className="mt-1 text-xs text-gray-500 dark:text-gray-400 leading-tight">
          {description}
        </span>
      </div>
    </motion.button>
  );
}
