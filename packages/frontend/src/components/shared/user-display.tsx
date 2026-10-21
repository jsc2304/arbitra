'use client';

import Image from 'next/image';
import type { User } from '@arbitra/shared';
import { isSystemActorId } from '../../lib/actor-display';
import { SystemActorPill } from './system-actor-pill';
import { UnknownUserPill } from './unknown-user-pill';

interface UserDisplayProps {
  userId: string;
  users: Record<string, User>;
  showAvatar?: boolean;
}

const COLORS = [
  'bg-secondary-100 text-secondary-700 dark:bg-secondary-900 dark:text-secondary-300',
  'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300',
];

function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length]!;
}

function getInitial(user: User): string {
  if (user.display_name) return user.display_name[0]!.toUpperCase();
  if (user.email) return user.email[0]!.toUpperCase();
  return '?';
}

function getLabel(user: User): string {
  return user.display_name || user.email || user.user_id;
}

export function UserDisplay({ userId, users, showAvatar = false }: UserDisplayProps) {
  const user = users[userId];

  if (!user) {
    // System actors never have a row in the user-map by design — render the
    // friendly pill instead of leaking `system:arbitra-webhook` style ids.
    if (isSystemActorId(userId)) {
      return <SystemActorPill actorId={userId} />;
    }
    // Human user ids that failed to resolve (deleted account, fetch failure,
    // ACL miss) get a neutral chip; the raw id is preserved on hover only.
    return <UnknownUserPill userId={userId} />;
  }

  const label = getLabel(user);

  if (!showAvatar) {
    return <span title={`${user.display_name ?? ''} <${user.email}>`}>{label}</span>;
  }

  const effectiveAvatar = user.custom_avatar_url || user.avatar_url;

  return (
    <span className="inline-flex items-center gap-1.5" title={`${user.display_name ?? ''} <${user.email}>`}>
      {effectiveAvatar ? (
        <Image src={effectiveAvatar} alt="" className="h-5 w-5 rounded-full flex-shrink-0" width={20} height={20} unoptimized />
      ) : (
        <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium flex-shrink-0 ${colorForId(userId)}`}>
          {getInitial(user)}
        </span>
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}
