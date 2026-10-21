'use client';

import { useState } from 'react';
import {
  buildInitSnippetTabs,
  INIT_IDES,
  INIT_IDE_LABELS,
  type InitIde,
  type InitSnippetInput,
} from '../../lib/init-snippets';

type Props = InitSnippetInput & {
  /** Callback invoked with the raw snippet text when the user clicks Copy. */
  onCopy?: (snippet: string) => void;
};

/**
 * Tabbed view of the Arbitra init command for the two supported shells, plus
 * an IDE picker that injects the matching `--ide` flag into the snippet.
 * Styling mirrors the tab pattern in `ide-agent-connect.tsx` (border-accent
 * under-line active tab). Used by both the Step-5 wizard tile and the
 * settings Setup panel — keep visual parity.
 */
export function InitCommandTabs({
  url,
  projectId,
  ide: initialIde,
  onCopy,
}: Props) {
  const [ide, setIde] = useState<InitIde>(initialIde ?? 'cursor');
  const tabs = buildInitSnippetTabs({ url, projectId, ide });
  type TabKey = (typeof tabs)[number]['key'];
  // Initial state: no OS picked yet — snippet stays hidden until the user
  // chooses one. Keeps users from copy-pasting the wrong shell's command.
  const [activeKey, setActiveKey] = useState<TabKey | null>(null);
  const [copied, setCopied] = useState(false);

  const activeTab = activeKey ? tabs.find((t) => t.key === activeKey) ?? null : null;

  function handleCopy() {
    if (!activeTab) return;
    navigator.clipboard.writeText(activeTab.snippet);
    if (onCopy) onCopy(activeTab.snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      {/* IDE picker — drives the --ide flag in the snippet. Cursor stays
          flag-free for back-compat; other values inject `--ide <value>`. */}
      <fieldset className="mb-3">
        <legend className="mb-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
          IDE
        </legend>
        <div
          role="radiogroup"
          aria-label="Target IDE"
          className="flex flex-wrap gap-1.5"
        >
          {INIT_IDES.map((value) => {
            const isActive = ide === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => setIde(value)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                  isActive
                    ? 'border-accent bg-accent-50 text-accent-700 dark:bg-accent-900/30 dark:text-accent-200'
                    : 'border-gray-200 dark:border-border-subtle text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-surface-raised'
                }`}
              >
                {INIT_IDE_LABELS[value]}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* Tab selector */}
      <div
        role="tablist"
        aria-label="Init command shell"
        className="mb-2 flex flex-wrap gap-1 border-b border-gray-200 dark:border-border-subtle"
      >
        {tabs.map((tab) => {
          const isActive = activeKey === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`init-panel-${tab.key}`}
              id={`init-tab-${tab.key}`}
              onClick={() => setActiveKey(tab.key)}
              className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-accent text-accent-700 dark:text-accent-300'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab ? (
        <>
          {/* Active tab hint */}
          <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{activeTab.hint}</p>

          {/* Snippet block */}
          <div
            role="tabpanel"
            id={`init-panel-${activeTab.key}`}
            aria-labelledby={`init-tab-${activeTab.key}`}
            className="relative"
          >
            <pre className="rounded-lg bg-gray-900 dark:bg-surface-base p-4 font-mono text-xs text-green-400 dark:text-green-300 overflow-x-auto whitespace-pre leading-relaxed">
              {activeTab.snippet}
            </pre>
            <button
              type="button"
              onClick={handleCopy}
              className="absolute top-2 right-2 rounded-md bg-gray-700 hover:bg-gray-600 px-2.5 py-1 text-[10px] font-medium text-gray-300 hover:text-white transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>

          {/* Optional callout (Windows Git-Bash-required note) */}
          {activeTab.callout && (
            <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
              {activeTab.callout}
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Select your OS to see the install command.
        </p>
      )}
    </div>
  );
}
