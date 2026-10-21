'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api-client';
import { searchDocs } from '../../lib/docs-search-index';
import type { SearchResult } from '@arbitra/shared';

const TYPE_ICONS: Record<string, string> = {
  case: 'C',
  finding: 'F',
  comment: 'T',
  doc: 'D',
};

const TYPE_COLORS: Record<string, string> = {
  case: 'bg-corp-blue/10 text-corp-dark dark:bg-corp-blue/20 dark:text-corp-blue',
  finding: 'bg-corp-orange/10 text-corp-dark dark:bg-corp-orange/20 dark:text-corp-orange',
  comment: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  doc: 'bg-corp-green/10 text-corp-dark dark:bg-corp-green/20 dark:text-corp-green',
};

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query || query.length < 2) return <>{text}</>;
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 0) return <>{text}</>;

  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(\\b(?:${escaped.join('|')})\\w*)`, 'gi');
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, i) => {
        const lower = part.toLowerCase();
        const isMatch = words.some((w) => lower.startsWith(w));
        return isMatch ? (
          <mark key={i} className="bg-corp-yellow/40 dark:bg-corp-yellow/30 text-inherit rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!query || query.length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api.search.query(query);
        // Client-side docs search
        const docResults: SearchResult[] = searchDocs(query).map((d) => ({
          type: 'doc' as const,
          id: d.id,
          case_id: '',
          title: d.title,
          snippet: d.text.slice(0, 150),
          meta: { status: d.section },
        }));
        setResults([...data.results, ...docResults]);
        setActiveIndex(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const navigate = useCallback(
    (result: SearchResult) => {
      onClose();
      if (result.type === 'doc') {
        router.push(`/docs#${result.id}`);
        // Fallback: scroll to anchor after navigation
        setTimeout(() => {
          document.getElementById(result.id)?.scrollIntoView({ behavior: 'smooth' });
        }, 100);
      } else if (result.type === 'finding') {
        router.push(`/cases/${result.case_id}/courtroom`);
      } else if (result.type === 'comment') {
        router.push(`/cases/${result.case_id}?tab=comments`);
      } else {
        router.push(`/cases/${result.case_id}`);
      }
    },
    [onClose, router],
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && results[activeIndex]) {
        e.preventDefault();
        navigate(results[activeIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [results, activeIndex, navigate, onClose],
  );

  // Group results by type
  const grouped: Record<string, SearchResult[]> = {};
  for (const r of results) {
    if (!grouped[r.type]) grouped[r.type] = [];
    grouped[r.type]!.push(r);
  }
  const groupOrder = ['case', 'finding', 'comment', 'doc'];
  const groupLabels: Record<string, string> = {
    case: 'Cases',
    finding: 'Findings',
    comment: 'Comments',
    doc: 'Documentation',
  };

  // Compute flat index for keyboard nav
  let flatIndex = 0;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative mx-auto mt-[5vh] md:mt-[15vh] w-full max-w-xl px-4 md:px-0">
        <div className="rounded-xl border border-gray-200 dark:border-border-subtle bg-surface-raised shadow-2xl overflow-hidden">
          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-gray-200 dark:border-border-subtle px-4 py-3">
            <svg className="h-5 w-5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              placeholder="Search cases, findings, comments, docs..."
              className="flex-1 bg-transparent text-base md:text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <kbd className="hidden sm:inline-flex items-center rounded border border-gray-200 dark:border-gray-600 bg-surface-base dark:bg-surface-base px-1.5 py-0.5 text-[10px] font-mono text-gray-400">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-[400px] overflow-y-auto">
            {loading && (
              <div className="flex items-center justify-center py-8">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 dark:border-gray-600 border-t-accent" />
              </div>
            )}

            {!loading && query.length >= 2 && results.length === 0 && (
              <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                No results for &ldquo;{query}&rdquo;
              </div>
            )}

            {!loading && results.length > 0 && (
              <div className="py-2">
                {groupOrder.map((type) => {
                  const group = grouped[type];
                  if (!group || group.length === 0) return null;
                  return (
                    <div key={type}>
                      <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                        {groupLabels[type]} ({group.length})
                      </div>
                      {group.map((result) => {
                        const idx = flatIndex++;
                        const isActive = idx === activeIndex;
                        return (
                          <button
                            key={result.id}
                            type="button"
                            className={`w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors ${
                              isActive
                                ? 'bg-accent/10 dark:bg-accent/20'
                                : 'hover:bg-surface-base dark:hover:bg-border-subtle/50'
                            }`}
                            onClick={() => navigate(result)}
                            onMouseEnter={() => setActiveIndex(idx)}
                          >
                            <span
                              className={`mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold flex-shrink-0 ${
                                TYPE_COLORS[result.type] ?? TYPE_COLORS.comment
                              }`}
                            >
                              {TYPE_ICONS[result.type] ?? '?'}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate" title={result.title}>
                                <Highlight text={result.title} query={query} />
                              </div>
                              <div className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1 mt-0.5" title={result.snippet}>
                                <Highlight text={result.snippet} query={query} />
                              </div>
                            </div>
                            {result.meta?.status && (
                              <span className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500 flex-shrink-0">
                                {result.meta.status.replace(/_/g, ' ')}
                              </span>
                            )}
                            {result.meta?.severity && (
                              <span className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500 flex-shrink-0">
                                {result.meta.severity}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}

            {!loading && query.length < 2 && (
              <div className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                Type to search across all cases, findings, comments, and docs
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-gray-200 dark:border-border-subtle px-4 py-2 text-[10px] text-gray-400 dark:text-gray-500">
            <div className="flex items-center gap-3">
              <span><kbd className="font-mono">&#8593;&#8595;</kbd> navigate</span>
              <span><kbd className="font-mono">&#9166;</kbd> open</span>
              <span><kbd className="font-mono">esc</kbd> close</span>
            </div>
            <span>{results.length > 0 ? `${results.length} results` : ''}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
