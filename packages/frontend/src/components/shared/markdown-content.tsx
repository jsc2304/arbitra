'use client';

import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  children: string;
  /** Extra Tailwind classes merged onto the prose wrapper */
  className?: string;
  /**
   * Per-element renderers for a caller that has to be stricter than the shared
   * default — see `assistant-answer-panel.tsx`, which drops image sources so a
   * URL another user wrote cannot fire an outbound request on view. Undefined
   * everywhere else, which is exactly what react-markdown does without it, so
   * every existing caller renders unchanged.
   */
  components?: Components;
}

/**
 * Reusable markdown renderer with consistent prose styling.
 *
 * Uses react-markdown (HTML-safe by default) + remark-gfm for
 * tables, strikethrough, task lists, and autolinks.
 */
export function MarkdownContent({ children, className = '', components }: MarkdownContentProps) {
  return (
    <div
      className={[
        // Base prose
        'prose prose-sm dark:prose-invert max-w-none',
        // Spacing
        'prose-p:my-2.5 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5',
        // Headings
        'prose-headings:mt-4 prose-headings:mb-2 prose-headings:text-gray-900 dark:prose-headings:text-gray-100',
        // Inline code
        'prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:bg-gray-100 prose-code:dark:bg-gray-800',
        'prose-code:text-[12px] prose-code:font-medium prose-code:before:content-none prose-code:after:content-none',
        // Bold
        'prose-strong:text-gray-900 prose-strong:dark:text-gray-100',
        // Code blocks
        'prose-pre:bg-surface-base prose-pre:dark:bg-surface-base prose-pre:text-gray-800 prose-pre:dark:text-gray-200',
        'prose-pre:border prose-pre:border-gray-200 prose-pre:dark:border-border-subtle',
        // Links
        'prose-a:text-accent-700 prose-a:dark:text-accent-300 prose-a:no-underline hover:prose-a:underline',
        // Tables
        'prose-th:text-left prose-th:text-gray-700 prose-th:dark:text-gray-300',
        // Blockquotes
        'prose-blockquote:border-gray-300 prose-blockquote:dark:border-gray-600 prose-blockquote:text-gray-600 prose-blockquote:dark:text-gray-400',
        className,
      ].join(' ')}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
