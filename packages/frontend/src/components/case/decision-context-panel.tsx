'use client';

/**
 * Decision Context panel (UI/UX 3-bets plan 1.6).
 *
 * Compact, single-row summary rendered above the case tabs. Surfaces the
 * **last decision** (type, actor, relative timestamp) so the user can see
 * the current approval state at a glance without opening the Decisions
 * tab.
 *
 * Returns `null` when no decision exists (typical for cases in early
 * states like `open` / `exploration`), so the panel stays invisible on
 * the happy path.
 *
 * Pending-gate signals are deliberately *not* rendered here — that
 * concern lives in `CaseHeader` → `GateBanner`, which already shows the
 * same information together with the Confirm/Decline buttons. Duplicating
 * it here created visual noise on pre-merge cases (see PR #243 review).
 *
 * Does **not** modify `decision-history.tsx` — shares its SWR cache key
 * (`['decisions', caseId]`) via `useLastDecision` so both surfaces
 * dedupe to a single fetch.
 */

import { useLastDecision } from '../../hooks/use-last-decision';
import { useUserMap } from '../../hooks/use-users';
import { actorDisplayName } from '../../lib/actor-display';
import { DECISION_TYPE_LABELS } from '../../lib/decision-type-labels';
import { RelativeTime } from '../shared/relative-time';
import ErrorCard from '../shared/error-card';

interface DecisionContextPanelProps {
  caseId: string;
}

export function DecisionContextPanel({ caseId }: DecisionContextPanelProps) {
  const { decision, isLoading, error } = useLastDecision(caseId);
  const actorIds = decision && !decision.actor_id.startsWith('system:') ? [decision.actor_id] : [];
  const userMap = useUserMap(actorIds);

  // Loading/error states only render once we know a decision exists. On
  // cases that have never had a decision the panel must stay invisible,
  // otherwise a flash of an empty loading placeholder appears in the
  // happy path.
  if (isLoading) return null;

  if (error) {
    // We can't tell whether a decision exists when the fetch failed. Err
    // on the side of surfacing the error so the user knows the Decisions
    // tab may be stale.
    return (
      <ErrorCard
        title="Decision context unavailable"
        message={error.message || 'Failed to load decisions'}
      />
    );
  }

  if (!decision) return null;

  const typeConfig = DECISION_TYPE_LABELS[decision.type] ?? {
    label: decision.type,
    className: 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800',
  };

  return (
    <div
      className="rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised px-3 py-2 sm:px-4 sm:py-2.5"
      aria-label="Decision context"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${typeConfig.className}`}
          >
            {typeConfig.label}
          </span>
          <span className="text-gray-700 dark:text-gray-300 truncate">
            by{' '}
            <span className="font-medium">
              {actorDisplayName(
                decision.actor_id,
                decision.actor_metadata,
                userMap[decision.actor_id]?.display_name || userMap[decision.actor_id]?.email || undefined,
              ).label}
            </span>
          </span>
          <RelativeTime
            timestamp={decision.created_at}
            className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap"
          />
        </div>
      </div>
    </div>
  );
}
