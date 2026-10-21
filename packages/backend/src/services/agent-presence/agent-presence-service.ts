import type { AgentPresence } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';

export interface UpsertPresenceInput {
  caseId: string;
  userId: string;
  source?: AgentPresence['source'];
}

export function presenceDocId(caseId: string, userId: string): string {
  return `${caseId}__${userId}`;
}

// Per-process actor-display cache. Avoids hitting `users` on every heartbeat
// when the same agent is hammering a case via MCP. TTL is intentionally
// process lifetime — display names rarely change and a stale label is
// acceptable for a presence pill.
const actorDisplayCache = new Map<string, string>();

async function resolveActorDisplay(userId: string): Promise<string> {
  const cached = actorDisplayCache.get(userId);
  if (cached) return cached;

  try {
    const snap = await collections.users().doc(userId).get();
    if (snap.exists) {
      const u = snap.data()!;
      const display = u.display_name || u.email || userId || 'agent';
      actorDisplayCache.set(userId, display);
      return display;
    }
  } catch {
    // fall through to fallback
  }
  const fallback = userId || 'agent';
  actorDisplayCache.set(userId, fallback);
  return fallback;
}

/** Test-only: clear the in-process actor display cache. */
export function __resetActorDisplayCache(): void {
  actorDisplayCache.clear();
}

/**
 * Idempotent presence upsert. Creates a new row on first contact (setting
 * `first_seen_at`), advances `last_seen_at` on every subsequent call. Doc id
 * is deterministic, so concurrent heartbeats merge cleanly without a
 * transaction in the steady state.
 */
export async function upsertPresence(input: UpsertPresenceInput): Promise<void> {
  const { caseId, userId } = input;
  if (!caseId || !userId) return;

  const source: AgentPresence['source'] = input.source ?? 'ide_agent';
  const presenceId = presenceDocId(caseId, userId);
  const ref = collections.agentPresence().doc(presenceId);
  const now = new Date().toISOString();
  const actorDisplay = await resolveActorDisplay(userId);

  // Existence check determines whether to set first_seen_at. A small race is
  // possible (two parallel first-time heartbeats both setting first_seen_at)
  // but the resulting value is still a sane "first seen" timestamp.
  const existing = await ref.get();
  if (existing.exists) {
    await ref.set(
      {
        presence_id: presenceId,
        case_id: caseId,
        actor_user_id: userId,
        actor_display: actorDisplay,
        source,
        last_seen_at: now,
      },
      { merge: true },
    );
    return;
  }

  const doc: AgentPresence = {
    presence_id: presenceId,
    case_id: caseId,
    actor_user_id: userId,
    actor_display: actorDisplay,
    source,
    first_seen_at: now,
    last_seen_at: now,
  };
  await ref.set(doc, { merge: true });
}

/**
 * Fire-and-forget wrapper. Heartbeats must never break the caller request,
 * so all errors are swallowed (and optionally logged via console.warn).
 */
export async function safeHeartbeat(input: UpsertPresenceInput): Promise<void> {
  try {
    await upsertPresence(input);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[agent-presence] heartbeat failed', err);
  }
}
