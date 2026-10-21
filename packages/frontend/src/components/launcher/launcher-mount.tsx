'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useLauncher } from '../../providers/launcher-provider';

/**
 * Lazy-mount wrapper around the full `LauncherOverlay`. The heavy overlay
 * (framer-motion variants, particle canvas, tiles, actionable-count hook)
 * only loads once the launcher is first opened — Cmd+K opens the command
 * palette rather than this overlay, so on most page loads this bundle is
 * never needed.
 *
 * Once the overlay has been opened the first time we keep it mounted so
 * that:
 *   - `AnimatePresence` inside the overlay can run its exit animation on
 *     close (an unmount here would skip that animation),
 *   - subsequent opens are instant with no additional network fetch.
 */
const LauncherOverlay = dynamic(
  () => import('./launcher-overlay').then((mod) => ({ default: mod.LauncherOverlay })),
  { ssr: false, loading: () => null },
);

export function LauncherMount() {
  const { isOpen } = useLauncher();
  const [hasEverOpened, setHasEverOpened] = useState(false);

  useEffect(() => {
    if (isOpen) setHasEverOpened(true);
  }, [isOpen]);

  if (!hasEverOpened) return null;
  return <LauncherOverlay />;
}
