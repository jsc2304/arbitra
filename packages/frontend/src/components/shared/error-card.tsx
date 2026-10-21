'use client';

import EmptyState from './empty-state';

interface ErrorCardProps {
  /** Heading shown above the message. Defaults to "Something went wrong". */
  title?: string;
  /** Human-readable error message. Required. */
  message: string;
  /**
   * Optional retry handler. When provided, a retry button is rendered;
   * otherwise the card is message-only.
   */
  onRetry?: () => void;
  className?: string;
}

/**
 * Reusable error display for transient fetch failures. Builds on
 * `EmptyState` with `variant="error"` so the visual language matches
 * across the app.
 */
export default function ErrorCard({
  title = 'Something went wrong',
  message,
  onRetry,
  className = '',
}: ErrorCardProps) {
  const icon = (
    <svg
      className="h-6 w-6 text-red-600 dark:text-red-400"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
      />
    </svg>
  );

  return (
    <div role="alert" className={className}>
      <EmptyState
        variant="error"
        icon={icon}
        title={title}
        description={message}
        action={onRetry ? { label: 'Retry', onClick: onRetry } : undefined}
      />
    </div>
  );
}
