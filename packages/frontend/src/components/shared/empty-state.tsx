'use client';

import type { ReactNode } from 'react';

export type EmptyStateVariant = 'default' | 'filter' | 'error';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
    /**
     * Disable the action button (e.g. while its async handler is in flight)
     * to prevent double-submit. Non-idempotent write handlers MUST set this.
     */
    disabled?: boolean;
  };
  /**
   * Optional color accent. When `undefined`, the component renders exactly
   * as before (neutral palette) so existing call sites stay byte-identical.
   *
   * - `default` — neutral (same as unset)
   * - `filter`  — amber accent for "no results matching filters" states
   * - `error`   — red accent for error surfaces (`ErrorCard` builds on this)
   */
  variant?: EmptyStateVariant;
  /** Optional icon slot rendered above the title. */
  icon?: ReactNode;
}

const variantClasses: Record<EmptyStateVariant, { wrapper: string; title: string; description: string }> = {
  default: {
    wrapper:
      'border-gray-300 dark:border-gray-600 bg-surface-base dark:bg-surface-base/50',
    title: 'text-gray-900 dark:text-gray-100',
    description: 'text-gray-500 dark:text-gray-400',
  },
  filter: {
    wrapper:
      'border-accent/20 bg-accent/10 dark:border-accent/30 dark:bg-accent/10',
    title: 'text-corp-dark dark:text-accent-200',
    description: 'text-corp-dark/80 dark:text-accent-300',
  },
  error: {
    wrapper:
      'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20',
    title: 'text-red-900 dark:text-red-100',
    description: 'text-red-700 dark:text-red-300',
  },
};

export default function EmptyState({ title, description, action, variant, icon }: EmptyStateProps) {
  const classes = variant ? variantClasses[variant] : variantClasses.default;

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 ${classes.wrapper}`}
    >
      {icon && <div className="mb-1 flex items-center justify-center">{icon}</div>}
      <h3 className={`text-base font-semibold ${classes.title}`}>{title}</h3>
      {description && <p className={`text-sm ${classes.description}`}>{description}</p>}
      {action && (
        <button
          onClick={action.onClick}
          disabled={action.disabled}
          className="mt-2 rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
