'use client';

import { useState, useEffect, useRef } from 'react';
import { MarkdownContent } from '../shared/markdown-content';

export function CollapsibleDescription({ description }: { description: string }) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    // Default-collapsed shows ~3 lines (max-h-[4.875rem] ≈ 78px at text-sm
    // with leading-relaxed). Treat anything taller as overflowing so the
    // "Show more" control appears only when the description actually spills
    // beyond the clamp.
    setIsOverflowing(el.scrollHeight > 68);
  }, [description]);

  return (
    <div className="mt-3 border-t border-gray-100 dark:border-border-subtle pt-3">
      <div
        ref={contentRef}
        className={`relative overflow-hidden transition-all ${
          !expanded && isOverflowing ? 'max-h-[4.3rem]' : ''
        }`}
      >
        <MarkdownContent className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">{description}</MarkdownContent>
        {!expanded && isOverflowing && (
          <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-surface-raised to-transparent" />
        )}
      </div>
      {isOverflowing && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs font-medium text-accent-700 dark:text-accent-300 hover:text-accent-800 dark:hover:text-accent-200 transition-colors"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
