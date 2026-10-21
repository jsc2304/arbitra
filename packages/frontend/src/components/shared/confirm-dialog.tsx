'use client';

import { useCallback } from 'react';
import { useEscapeKey } from '../../hooks/use-escape-key';
import { Button, type ButtonVariant } from '../ui/button';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const variantStyles = {
  danger: {
    icon: (
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 dark:bg-red-950">
        <svg className="h-5 w-5 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
        </svg>
      </div>
    ),
    // Maps to the shared <Button> `danger` variant.
    button: 'danger' as ButtonVariant,
    buttonClassName: undefined as string | undefined,
  },
  warning: {
    icon: (
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950">
        <svg className="h-5 w-5 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
        </svg>
      </div>
    ),
    // Maps to the shared <Button> `warning` variant.
    button: 'warning' as ButtonVariant,
    buttonClassName: undefined as string | undefined,
  },
  default: {
    icon: (
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
        <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
        </svg>
      </div>
    ),
    // Neutral gray confirm — maps to the shared <Button> `neutral` variant, so
    // no conflicting `bg-*` utilities reach the DOM via a className override.
    button: 'neutral' as ButtonVariant,
    buttonClassName: undefined as string | undefined,
  },
};

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const handleEscape = useCallback(() => {
    if (!loading) onCancel();
  }, [onCancel, loading]);

  useEscapeKey(handleEscape, open);

  if (!open) return null;

  const styles = variantStyles[variant];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) {
          onCancel();
        }
      }}
    >
      <div className="mx-4 w-full max-w-sm rounded-lg bg-surface-raised shadow-xl">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-3">
            {styles.icon}
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">{message}</p>
        </div>
        <div className="border-t border-gray-200 dark:border-border-subtle px-6 py-4 flex justify-end gap-3">
          {/* Cancel is a text-only control (no border, no hover bg) — render the
              base <Button> and override colours via className to keep parity. */}
          <Button
            variant="ghost"
            onClick={onCancel}
            disabled={loading}
            className="text-gray-600 dark:text-gray-400 hover:bg-transparent dark:hover:bg-transparent hover:text-gray-800 dark:hover:text-gray-200"
          >
            {cancelLabel}
          </Button>
          {/* Keep the original label-swap (no spinner) for visual parity —
              `disabled` mirrors the prior behaviour, not the `loading` prop. */}
          <Button
            variant={styles.button}
            onClick={onConfirm}
            disabled={loading}
            className={styles.buttonClassName}
          >
            {loading ? 'Processing...' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
