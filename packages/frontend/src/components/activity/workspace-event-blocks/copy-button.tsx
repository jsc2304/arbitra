'use client';

import { useState } from 'react';

/**
 * Small inline "Copy" action used by workspace-event blocks. Kept local to
 * this folder — the broader app already has copy-to-clipboard scattered
 * across components (tokens panel, init tabs, etc.); a two-line helper
 * doesn't warrant a new shared primitive. Resets the "Copied" label after
 * ~1.5s so users can copy again without a page interaction.
 */
export function CopyButton({
  value,
  label = 'Copy',
  ariaLabel,
}: {
  value: string;
  label?: string;
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function onClick() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard can fail on http:// origins or when permission is denied;
      // swallow — the snippet is still visible in the <pre> next to the
      // button so the user can select-and-copy manually.
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      className="inline-flex shrink-0 items-center rounded-md border border-gray-200 dark:border-border-subtle bg-surface-base dark:bg-surface-base/40 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-border-subtle/40 transition-colors"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
