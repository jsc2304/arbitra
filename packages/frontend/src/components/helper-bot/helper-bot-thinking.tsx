'use client';

/**
 * HelperBotThinking — compact "request in flight" indicator for the
 * helper bot drawer. Three small dots with staggered pulse, like a
 * typing indicator, tinted Arbitra orange so the bot still feels
 * "of Arbitra" without dominating the chat column.
 *
 * Visual language:
 *   - Reuses the orange `pulse-glow` keyframe (defined in `globals.css`,
 *     registered as the `animate-pulse-glow` Tailwind utility). Same
 *     glow used by the launcher tile's highlighted state — see
 *     `components/launcher/launcher-tile.tsx`. The accent color
 *     (`#F79724`, a.k.a. `corp-orange`) is what the keyframe shadows out
 *     from `currentColor`, so we set `bg-corp-orange text-corp-orange`.
 *   - Three dots with staggered `animation-delay` to give the typing-
 *     indicator rhythm. Pure CSS, no framer-motion, no JS timers.
 *
 * Contract:
 *   - No required props. `className` lets the caller position it inside
 *     the drawer's flex column.
 *   - `data-testid="helper-bot-thinking"` for the new convention; the
 *     legacy `helper-bot-loading` testid is preserved on a sibling
 *     sr-only marker for back-compat with existing tests.
 */

interface HelperBotThinkingProps {
  className?: string;
}

const DOT_DELAYS = ['0s', '0.2s', '0.4s'] as const;

export function HelperBotThinking({ className = '' }: HelperBotThinkingProps) {
  return (
    <div
      className={`inline-flex items-center gap-1.5 ${className}`}
      role="status"
      aria-live="polite"
      aria-label="Arbitra Helper is thinking"
      data-testid="helper-bot-thinking"
    >
      {/* Hidden marker preserves the legacy testid + provides screen-reader text. */}
      <span className="sr-only" data-testid="helper-bot-loading">
        Thinking…
      </span>

      {DOT_DELAYS.map((delay, idx) => (
        <span
          key={idx}
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full bg-corp-orange text-corp-orange animate-pulse-glow"
          style={{ animationDelay: delay }}
        />
      ))}
    </div>
  );
}
