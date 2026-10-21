'use client';

import { isSystemActorId } from '../../lib/actor-display';
import { Badge } from './badge';

export type SystemActorKind = 'system' | 'webhook' | 'intelligence' | 'pipeline' | 'agent';

interface SystemActorPillProps {
  /**
   * Raw actor id (e.g. `system`, `system:arbitra-webhook`,
   * `system:arbitra-intelligence`, `system:pipeline`). Used both to derive the
   * pill kind/label and as a `title` attribute so power-users can still
   * inspect the underlying id on hover.
   */
  actorId: string;
}

/**
 * Maps the raw `system` / `system:*` id family onto a human-readable label
 * and matching glyph. Resolution order: exact known suffixes → friendly
 * fallback ("Arbitra agent") so the UI never surfaces a raw `system:foo`
 * string. The mapping intentionally favors a tight set of well-known
 * actors over title-casing arbitrary suffixes; a new actor only needs an
 * entry here to render correctly across the app.
 */
function classifySystemActor(actorId: string): { kind: SystemActorKind; label: string } {
  if (actorId === 'system') return { kind: 'system', label: 'System' };
  const suffix = actorId.startsWith('system:') ? actorId.slice('system:'.length) : '';
  if (suffix.includes('webhook')) return { kind: 'webhook', label: 'Webhook' };
  if (suffix.includes('intelligence')) return { kind: 'intelligence', label: 'Code Intelligence' };
  if (suffix === 'pipeline') return { kind: 'pipeline', label: 'Pipeline' };
  return { kind: 'agent', label: 'Arbitra agent' };
}

const KIND_ICON: Record<SystemActorKind, React.JSX.Element> = {
  system: (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-3 w-3 flex-shrink-0"
    >
      <path
        fillRule="evenodd"
        d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 0 1-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 0 1 .947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 0 1 2.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 0 1 2.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 0 1 .947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 0 1-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 0 1-2.287-.947ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
        clipRule="evenodd"
      />
    </svg>
  ),
  webhook: (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-3 w-3 flex-shrink-0"
    >
      <path
        fillRule="evenodd"
        d="M11.983 1.907a.75.75 0 0 0-1.292-.657l-8.5 9.5A.75.75 0 0 0 2.75 12h6.572l-1.305 6.093a.75.75 0 0 0 1.292.657l8.5-9.5A.75.75 0 0 0 17.25 8h-6.572l1.305-6.093Z"
        clipRule="evenodd"
      />
    </svg>
  ),
  intelligence: (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-3 w-3 flex-shrink-0"
    >
      <path d="M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM7 9a3 3 0 1 1 6 0 3 3 0 0 1-6 0Z" />
    </svg>
  ),
  pipeline: (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-3 w-3 flex-shrink-0"
    >
      <path d="M3 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm8 6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-2ZM7 11h2v2H7v-2Zm6-6h-2v2h2V5Z" />
    </svg>
  ),
  agent: (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-3 w-3 flex-shrink-0"
    >
      <path
        fillRule="evenodd"
        d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 0 1-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 0 1 .947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 0 1 2.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 0 1 2.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 0 1 .947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 0 1-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 0 1-2.287-.947ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
        clipRule="evenodd"
      />
    </svg>
  ),
};

/**
 * Renders a non-human (`system` / `system:*`) actor as a friendly chip with
 * an icon. Always preferable to leaking `system:arbitra-webhook` style ids
 * into the UI. Pair with `isSystemActorId` to gate rendering.
 */
export function SystemActorPill({ actorId }: SystemActorPillProps) {
  const { kind, label } = classifySystemActor(actorId);
  return (
    <Badge
      size="xs"
      tone="solid"
      colorClassName="bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
      icon={KIND_ICON[kind]}
      data-testid="system-actor-pill"
      data-kind={kind}
      title={`${label} (${actorId})`}
    >
      <span>{label}</span>
    </Badge>
  );
}

export { isSystemActorId };
