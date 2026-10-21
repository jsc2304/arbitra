'use client';

import { useState, useEffect, useCallback } from 'react';
import { usePathname } from 'next/navigation';

const STORAGE_KEY = 'arbitra-onboarding-state';

interface OnboardingState {
  completedSteps: string[];
  dismissed: boolean;
  firstSeen: string;
}

export interface OnboardingStep {
  id: string;
  label: string;
  description: string;
  href: string;
  completed: boolean;
}

const STEPS_CONFIG = [
  { id: 'explore-board', label: 'Explore the Board', description: 'See all your cases at a glance', href: '/board' },
  { id: 'setup-project', label: 'Set up a Project', description: 'Connect a repository to start', href: '/setup/new-project' },
  { id: 'setup-ide', label: 'Connect your IDE Agent', description: 'Run the init command to link Claude Code or Cursor', href: '/settings?tab=setup' },
  { id: 'visit-courtroom', label: 'Review in the Courtroom', description: 'Make decisions on findings', href: '/board?view=ready-to-approve' },
  { id: 'check-observatory', label: 'Check the Observatory', description: 'Explore metrics and insights', href: '/observatory' },
  { id: 'read-docs', label: 'Browse Documentation', description: 'Learn how Arbitra works', href: '/docs' },
];

function readState(): OnboardingState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OnboardingState) : null;
  } catch {
    return null;
  }
}

function writeState(state: OnboardingState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // silently fail
  }
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const existing = readState();
    if (existing) {
      setState(existing);
    } else {
      const initial: OnboardingState = { completedSteps: [], dismissed: false, firstSeen: new Date().toISOString() };
      writeState(initial);
      setState(initial);
    }
    setHydrated(true);
  }, []);

  const completeStep = useCallback((stepId: string) => {
    setState((prev) => {
      if (!prev) return prev;
      if (prev.completedSteps.includes(stepId)) return prev;
      const next = { ...prev, completedSteps: [...prev.completedSteps, stepId] };
      writeState(next);
      return next;
    });
  }, []);

  const dismiss = useCallback(() => {
    setState((prev) => {
      if (!prev) return prev;
      const next = { ...prev, dismissed: true };
      writeState(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (pathname?.startsWith('/board') && state && !state.completedSteps.includes('explore-board')) {
      completeStep('explore-board');
    }
  }, [pathname, state, completeStep]);

  const steps: OnboardingStep[] = STEPS_CONFIG.map((s) => ({
    ...s,
    completed: state?.completedSteps.includes(s.id) ?? false,
  }));

  const allCompleted = steps.every((s) => s.completed);
  const isVisible = hydrated && state !== null && !state.dismissed && !allCompleted;
  const isNewUser = hydrated && state !== null && state.completedSteps.length === 0 && !state.dismissed;

  return { steps, completeStep, dismiss, isNewUser, isVisible };
}
