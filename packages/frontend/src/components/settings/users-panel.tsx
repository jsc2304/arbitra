'use client';

import { useState } from 'react';
import Image from 'next/image';
import useSWR from 'swr';
import type { User, UserRole } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useIsAdmin } from '../../hooks/use-is-admin';
import { useToast } from '../../providers/toast-provider';
import { RelativeTime } from '../shared/relative-time';
import Card from '../shared/card';
import SectionHeader from '../shared/section-header';
import EmptyState from '../shared/empty-state';
import { Modal } from '../shared/modal';
import { Button } from '../ui/button';

const ALL_ROLES: { key: UserRole; label: string }[] = [
  { key: 'developer', label: 'Developer' },
  { key: 'reviewer', label: 'Reviewer' },
  { key: 'tech_lead', label: 'Tech Lead' },
  { key: 'admin', label: 'Admin' },
];

const ROLE_COLORS: Record<UserRole, { bg: string; text: string }> = {
  developer: { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-700 dark:text-gray-300' },
  reviewer: { bg: 'bg-blue-100 dark:bg-blue-900/50', text: 'text-blue-700 dark:text-blue-300' },
  tech_lead: { bg: 'bg-purple-100 dark:bg-purple-900/50', text: 'text-purple-700 dark:text-purple-300' },
  admin: { bg: 'bg-amber-100 dark:bg-amber-900/50', text: 'text-amber-700 dark:text-amber-300' },
};

function roleBadge(role: UserRole) {
  const colors = ROLE_COLORS[role] ?? ROLE_COLORS.developer;
  const label = ALL_ROLES.find((r) => r.key === role)?.label ?? role;
  return (
    <span
      key={role}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${colors.bg} ${colors.text}`}
    >
      {label}
    </span>
  );
}

export function UsersPanel() {
  const { isAdmin } = useIsAdmin();
  const { data, error, mutate } = useSWR('all-users-admin', () => api.users.list());
  const users = data?.users ?? [];
  const { addToast } = useToast();

  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [clearingUser, setClearingUser] = useState<User | null>(null);

  if (error) {
    const is403 = error?.message?.includes('403') || error?.message?.includes('Admin');
    if (is403) {
      return (
        <div className="max-w-3xl">
          <EmptyState
            icon={
              <svg className="h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
            }
            title="Admin access required"
            description="Only administrators can view and manage users. Contact your admin if you need access."
          />
        </div>
      );
    }
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-red-600 dark:text-red-400">Failed to load users: {error.message}</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <section>
        <SectionHeader
          eyebrow
          title="Users"
          count={users.length}
          className="mb-3"
        />

        <Card padding="none" className="divide-y divide-gray-100 dark:divide-gray-800">
          {users.length === 0 && !error && (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">No users found.</p>
            </div>
          )}

          {users.map((user) => {
            const avatar = user.custom_avatar_url || user.avatar_url;
            return (
            <div key={user.user_id} className="px-4 py-3 flex items-center gap-3">
              {/* Avatar */}
              {avatar ? (
                <Image
                  src={avatar}
                  alt={user.display_name}
                  className="h-8 w-8 rounded-full flex-shrink-0"
                  width={32}
                  height={32}
                  unoptimized
                />
              ) : (
                <div className="h-8 w-8 rounded-full bg-secondary-100 dark:bg-secondary-900/50 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-medium text-secondary-700 dark:text-secondary-300">
                    {(user.display_name || user.email || '?').charAt(0).toUpperCase()}
                  </span>
                </div>
              )}

              {/* Name & email */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {user.display_name}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
              </div>

              {/* Role badges */}
              <div className="flex flex-wrap gap-1">
                {(user.roles ?? []).map((role) => roleBadge(role as UserRole))}
              </div>

              {/* Created at */}
              <RelativeTime
                timestamp={user.created_at}
                className="text-[11px] text-gray-400 dark:text-gray-500 flex-shrink-0 hidden sm:block"
              />

              {/* Clear Chat identity (admin only, only when a mapping exists) */}
              {isAdmin && user.chat_identity && (
                <button
                  onClick={() => setClearingUser(user)}
                  className="border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-border-subtle px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex-shrink-0"
                >
                  Clear Chat Identity
                </button>
              )}

              {/* Edit button (admin only) */}
              {isAdmin && (
                <button
                  onClick={() => setEditingUser(user)}
                  className="bg-accent-700 hover:bg-accent-800 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex-shrink-0"
                >
                  Edit Roles
                </button>
              )}
            </div>
            );
          })}
        </Card>
      </section>

      {/* Edit Roles Modal */}
      {editingUser && (
        <EditRolesModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSaved={() => {
            mutate();
            addToast('success', `Roles updated for ${editingUser.display_name}`);
            setEditingUser(null);
          }}
        />
      )}

      {/* Clear Chat Identity confirm (issue #1069 fix 1) */}
      {clearingUser && (
        <ClearChatIdentityModal
          user={clearingUser}
          onClose={() => setClearingUser(null)}
          onCleared={() => {
            mutate();
            addToast('success', `Chat identity cleared for ${clearingUser.display_name}`);
            setClearingUser(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Confirm-only dialog for issue #1069 fix 1. No field to fill in — `chat_user_id` is an opaque Google Chat
 * resource id nobody can look up, so this only clears the existing mapping
 * back to unmapped; the correct account's next Chat message re-establishes
 * it via `mapChatIdentity`.
 */
function ClearChatIdentityModal({
  user,
  onClose,
  onCleared,
}: {
  user: User;
  onClose: () => void;
  onCleared: () => void;
}) {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClear() {
    setClearing(true);
    setError(null);
    try {
      await api.users.clearChatIdentity(user.user_id);
      onCleared();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to clear Chat identity';
      setError(msg);
    } finally {
      setClearing(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Clear Chat identity?"
      closeDisabled={clearing}
      width="sm"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={clearing}
            className="text-gray-600 dark:text-gray-400 hover:bg-transparent dark:hover:bg-transparent hover:text-gray-800 dark:hover:text-gray-200"
          >
            Cancel
          </Button>
          <Button onClick={handleClear} disabled={clearing}>
            {clearing ? 'Clearing...' : 'Clear Chat Identity'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-700 dark:text-gray-300">
        This removes the Chat identity mapping for <strong>{user.display_name}</strong>. It does
        not bind a new one — the correct Google Chat account re-establishes the mapping the next
        time it messages Clerk.
      </p>
      {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Modal>
  );
}

function EditRolesModal({
  user,
  onClose,
  onSaved,
}: {
  user: User;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selectedRoles, setSelectedRoles] = useState<Set<UserRole>>(
    new Set((user.roles ?? []) as UserRole[]),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addToast } = useToast();

  function toggleRole(role: UserRole) {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) {
        next.delete(role);
      } else {
        next.add(role);
      }
      return next;
    });
  }

  async function handleSave() {
    if (selectedRoles.size === 0) {
      setError('At least one role is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.users.updateRoles(user.user_id, Array.from(selectedRoles));
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update roles';
      setError(msg);
      addToast('error', msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit Roles"
      closeDisabled={saving}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={saving}
            className="text-gray-600 dark:text-gray-400 hover:bg-transparent dark:hover:bg-transparent hover:text-gray-800 dark:hover:text-gray-200"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || selectedRoles.size === 0}
          >
            {saving ? 'Saving...' : 'Save Roles'}
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-3 mb-4">
        {user.custom_avatar_url || user.avatar_url ? (
          <Image src={user.custom_avatar_url || user.avatar_url || ''} alt={user.display_name} className="h-10 w-10 rounded-full" width={40} height={40} unoptimized />
        ) : (
          <div className="h-10 w-10 rounded-full bg-secondary-100 dark:bg-secondary-900/50 flex items-center justify-center">
            <span className="text-sm font-medium text-secondary-700 dark:text-secondary-300">
              {(user.display_name || '?').charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{user.display_name}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{user.email}</p>
        </div>
      </div>

      <div className="space-y-2">
        {ALL_ROLES.map(({ key, label }) => (
          <label
            key={key}
            className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-surface-base dark:hover:bg-border-subtle cursor-pointer transition-colors"
          >
            <input
              type="checkbox"
              checked={selectedRoles.has(key)}
              onChange={() => toggleRole(key)}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-accent focus:ring-accent"
            />
            <span className="text-sm text-gray-900 dark:text-gray-100">{label}</span>
            {roleBadge(key)}
          </label>
        ))}
      </div>

      {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Modal>
  );
}
