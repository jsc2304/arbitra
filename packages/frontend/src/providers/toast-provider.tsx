'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  description?: string;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, description?: string) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let toastCounter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (type: ToastType, message: string, description?: string) => {
      const id = `toast-${++toastCounter}`;
      setToasts((prev) => [...prev, { id, type, message, description }]);

      // Toasts with a secondary line need a touch longer to read; bump the
      // info/success duration when a description is present so users can
      // actually parse the why-line before it auto-dismisses.
      const baseDuration = type === 'error' ? 5500 : 3500;
      const duration = description ? Math.max(baseDuration, 6500) : baseDuration;
      setTimeout(() => removeToast(id), duration);
    },
    [removeToast],
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

/**
 * Like `useToast` but returns `null` when no provider is mounted instead of
 * throwing. Use from utility hooks (e.g. `useUserMap`) that may be exercised
 * in environments without the full app shell — server-rendered tests, isolated
 * snapshot tests, etc. — where a real toast doesn't matter.
 */
export function useOptionalToast() {
  return useContext(ToastContext);
}
