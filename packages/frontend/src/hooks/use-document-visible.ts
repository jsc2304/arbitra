'use client';

import { useSyncExternalStore } from 'react';

/**
 * Tracks `document.visibilityState` as a boolean — true when the tab is
 * visible (or foregrounded), false while it's hidden (backgrounded tab,
 * minimized window, switched to another tab).
 *
 * Built on `useSyncExternalStore` (React 18) rather than a `useState` +
 * `useEffect` pair so it never renders a stale value on the very first
 * paint: the snapshot is read synchronously during render, not after an
 * effect flush.
 *
 * SSR-safe: `getSnapshot` reports `true` when `document` doesn't exist, and
 * `useSyncExternalStore`'s third argument mirrors that for the server
 * snapshot, so hydration never mismatches.
 */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}

function subscribe(onStoreChange: () => void): () => void {
  document.addEventListener('visibilitychange', onStoreChange);
  return () => document.removeEventListener('visibilitychange', onStoreChange);
}

function getSnapshot(): boolean {
  return typeof document === 'undefined' ? true : document.visibilityState !== 'hidden';
}
