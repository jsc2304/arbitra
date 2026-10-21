'use client';

import Link from 'next/link';
import useSWR from 'swr';
import type { Case } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useAuth } from '../../providers/auth-provider';
import { getCasePollingInterval } from '../../lib/case-polling';
import LoadingSpinner from '../shared/loading-spinner';
import ErrorCard from '../shared/error-card';
import { StatusBadge } from '../shared/status-badge';
import { RelativeTime } from '../shared/relative-time';

export function assistantThreadSwrKey(
  caseId: string,
  uid: string | undefined,
): [string, string, string] | null {
  return uid ? ['assistant-thread', caseId, uid] : null;
}

export function AssistantThreadPanel({ caseData }: { caseData: Case }) {
  const { user } = useAuth();
  const isRequester = caseData.owner_user_id === user?.uid
    && caseData.assistant_context?.requester_user_id === user?.uid;
  const { data, error, mutate } = useSWR(
    isRequester ? assistantThreadSwrKey(caseData.case_id, user?.uid) : null,
    () => api.assistant.getThread(caseData.case_id),
    { refreshInterval: getCasePollingInterval(caseData.status) },
  );

  if (!isRequester) return null;
  if (error) {
    return (
      <ErrorCard
        title="Conversation unavailable"
        message={error instanceof Error ? error.message : 'The Clerk conversation could not be loaded.'}
        onRetry={() => void mutate()}
      />
    );
  }
  if (!data) {
    return (
      <section aria-label="Clerk conversation" className="bg-surface-raised border border-border-subtle rounded-lg px-4 py-3">
        <span className="inline-flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <LoadingSpinner size="sm" /> Loading conversation
        </span>
      </section>
    );
  }

  return (
    <section aria-label="Clerk conversation" className="bg-surface-raised border border-border-subtle rounded-lg">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-2.5">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Conversation</h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {data.turns.length} turn{data.turns.length === 1 ? '' : 's'}
        </span>
      </div>
      <ol className="divide-y divide-border-subtle">
        {data.turns.map((turn) => (
          <li key={turn.case_id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
                Turn {turn.depth + 1}
              </span>
              <StatusBadge status={turn.status} />
              <RelativeTime timestamp={turn.created_at} />
              {turn.case_id === caseData.case_id ? (
                <span className="text-xs text-gray-500 dark:text-gray-400">Current</span>
              ) : (
                <Link
                  href={`/cases/${turn.case_id}`}
                  className="text-xs text-accent-700 hover:text-accent-800 dark:text-accent-300"
                >
                  Open turn
                </Link>
              )}
            </div>
            <p className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100 whitespace-pre-wrap">
              {turn.request}
            </p>
            {turn.answer_preview && (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {turn.answer_preview}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
