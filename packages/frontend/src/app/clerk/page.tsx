'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ClerkAskPanel } from '../../components/clerk/clerk-ask-panel';
import { ClerkContextPanel } from '../../components/clerk/clerk-context-panel';
import { ClerkScheduledPanel } from '../../components/clerk/clerk-scheduled-panel';
import LoadingSpinner from '../../components/shared/loading-spinner';
import { CLERK_TABS, resolveClerkTab, type ClerkTab } from '../../lib/clerk-tabs';

function ClerkPageContent() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<ClerkTab>(resolveClerkTab(searchParams.get('tab')));

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-8 space-y-4">
      <div>
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
          Clerk
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Your assistant for questions about what is in Arbitra. Every request becomes a case in your
          private Clerk project.
        </p>
      </div>

      {/* Tab bar — pattern: settings/page.tsx (useState tab, button list,
          active underline, conditional render below). */}
      <div className="border-b border-gray-200 dark:border-border-subtle">
        <nav className="flex items-end gap-6">
          {CLERK_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-accent text-accent-700 dark:text-accent-300'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'ask' && <ClerkAskPanel />}
      {activeTab === 'context' && <ClerkContextPanel />}
      {activeTab === 'scheduled' && <ClerkScheduledPanel />}
    </div>
  );
}

function ClerkPageLoading() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-8 flex justify-center">
      <LoadingSpinner size="md" />
    </div>
  );
}

/**
 * `useSearchParams()` de-opts to client rendering up to the nearest
 * Suspense boundary (Next.js App Router contract), so the tab-reading
 * content is split out from the default export the same way
 * `review-session/page.tsx` splits `ReviewSessionContent` from
 * `ReviewSessionPage` — otherwise the whole route would de-opt.
 */
export default function ClerkPage() {
  return (
    <Suspense fallback={<ClerkPageLoading />}>
      <ClerkPageContent />
    </Suspense>
  );
}
