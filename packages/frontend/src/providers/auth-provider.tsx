'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { User } from 'firebase/auth';
import { api } from '../lib/api-client';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /**
   * User-supplied avatar override (from `users/{uid}.custom_avatar_url`).
   * Prefer this over `user.photoURL` when rendering the signed-in user's
   * avatar — Firebase's `photoURL` can be stale or resolve to a silhouette
   * placeholder for some Workspace tenants.
   *
   * Loaded via `GET /api/users/me` because `firestore.rules` deny direct
   * client reads ("all access goes through the backend").
   */
  customAvatarUrl: string | null;
  /** Re-fetch `/api/users/me` — call after self-updates so the header reflects the change. */
  refreshCustomAvatarUrl: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  customAvatarUrl: null,
  refreshCustomAvatarUrl: async () => {},
  signIn: async () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [customAvatarUrl, setCustomAvatarUrl] = useState<string | null>(null);
  const currentUidRef = useRef<string | null>(null);

  const fetchProfileForCurrentUser = useCallback(async () => {
    const uidAtStart = currentUidRef.current;
    if (!uidAtStart) {
      setCustomAvatarUrl(null);
      return;
    }
    try {
      const me = await api.users.me();
      // Ignore the response if the signed-in user changed while the request was in flight.
      if (currentUidRef.current !== uidAtStart) return;
      const next = me.custom_avatar_url;
      setCustomAvatarUrl(typeof next === 'string' && next.length > 0 ? next : null);
    } catch {
      if (currentUidRef.current !== uidAtStart) return;
      setCustomAvatarUrl(null);
    }
  }, []);

  useEffect(() => {
    let unsubscribeAuth: (() => void) | undefined;

    async function initAuth() {
      try {
        const { onAuthStateChanged } = await import('firebase/auth');
        const { getClientAuth } = await import('../lib/firebase-client');

        unsubscribeAuth = onAuthStateChanged(getClientAuth(), (firebaseUser) => {
          setUser(firebaseUser);
          setLoading(false);
          currentUidRef.current = firebaseUser?.uid ?? null;
          if (firebaseUser) {
            void fetchProfileForCurrentUser();
          } else {
            setCustomAvatarUrl(null);
          }
        });
      } catch {
        // Firebase not available — treat as unauthenticated
        setLoading(false);
      }
    }

    initAuth();
    return () => {
      unsubscribeAuth?.();
    };
  }, [fetchProfileForCurrentUser]);

  const signIn = async () => {
    const { signInWithGoogle } = await import('../lib/firebase-client');
    await signInWithGoogle();
  };

  const signOut = async () => {
    const { getClientAuth } = await import('../lib/firebase-client');
    await getClientAuth().signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        customAvatarUrl,
        refreshCustomAvatarUrl: fetchProfileForCurrentUser,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
