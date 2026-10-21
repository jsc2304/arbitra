'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

interface LauncherContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  /** Callback registered by HeaderBar so the Search tile can open CommandPalette */
  openSearch: (() => void) | null;
  registerOpenSearch: (fn: () => void) => void;
}

const LauncherContext = createContext<LauncherContextValue>({
  isOpen: false,
  open: () => {},
  close: () => {},
  openSearch: null,
  registerOpenSearch: () => {},
});

export function useLauncher() {
  return useContext(LauncherContext);
}

export function LauncherProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const openSearchRef = useRef<(() => void) | null>(null);
  const triggerRef = useRef<Element | null>(null);

  const open = useCallback(() => {
    triggerRef.current = document.activeElement;
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    // Restore focus to trigger element
    requestAnimationFrame(() => {
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    });
  }, []);

  const registerOpenSearch = useCallback((fn: () => void) => {
    openSearchRef.current = fn;
  }, []);

  // Escape key closes the launcher
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(false);
        requestAnimationFrame(() => {
          if (triggerRef.current instanceof HTMLElement) {
            triggerRef.current.focus();
          }
        });
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen]);

  return (
    <LauncherContext.Provider
      value={{
        isOpen,
        open,
        close,
        openSearch: openSearchRef.current,
        registerOpenSearch,
      }}
    >
      {children}
    </LauncherContext.Provider>
  );
}
