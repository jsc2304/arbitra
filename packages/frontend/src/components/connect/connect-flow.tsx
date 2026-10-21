'use client';

/**
 * `<ConnectFlow>` — main client component of the `/connect` page.
 *
 * Spec: `docs/specs/device-flow-and-per-tool-tokens.md` §F.1.
 *
 * State branches:
 *   1. No `code` in URL          → render `<CodeInput>`, push `?code=…` on submit.
 *   2. `code` present, signed-in → fetch metadata + project matches, render
 *      `<ConfirmPanel>` or success view.
 *   3. `code` present, NOT signed-in → handled by the global `<AuthGate>` in
 *      `app/layout.tsx`. The popup-based Google sign-in keeps the URL intact
 *      (spec §A.5), so this component never sees the signed-out branch
 *      directly.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { api } from '../../lib/api-client';
import { useAuth } from '../../providers/auth-provider';
import { useToast } from '../../providers/toast-provider';
import LoadingSpinner from '../shared/loading-spinner';
import { CodeInput } from './code-input';
import { ConfirmPanel } from './confirm-panel';
import { SuccessView } from './success-view';

interface ConnectFlowProps {
  /** From `searchParams.code` on the server. May be `null` or already-validated. */
  initialCode: string | null;
}

export function ConnectFlow({ initialCode }: ConnectFlowProps) {
  const router = useRouter();
  const { user, signOut, signIn } = useAuth();
  const { addToast } = useToast();
  const [successProject, setSuccessProject] = useState<string | null>(null);

  // ── Branch 1: no code → render code-entry ────────────────────────────────
  if (!initialCode) {
    return (
      <div className="flex flex-col items-center gap-6 py-12">
        <header className="text-center">
          <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">Connect to Arbitra</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 max-w-md">
            Paste the one-time code your tool printed. We will match it with this account.
          </p>
        </header>
        <CodeInput onSubmit={(code) => router.push(`/connect?code=${encodeURIComponent(code)}`)} />
      </div>
    );
  }

  // ── Branch 3: success view (post-Confirm) ─────────────────────────────
  if (successProject) {
    return <SuccessView projectName={successProject} />;
  }

  // ── Branch 2: code + (assumed) signed-in user. AuthGate wraps the route,
  // so `user` is guaranteed non-null by the time we reach this branch under
  // normal flow. Guard defensively for hydration races.
  if (!user) {
    // AuthGate is rendering its sign-in card above us; show nothing here.
    return null;
  }

  return (
    <SignedInConfirmView
      userCode={initialCode}
      userEmail={user.email ?? ''}
      userPhotoURL={user.photoURL}
      onCancel={async () => {
        try {
          await api.auth.connect.cancel({ user_code: initialCode });
        } catch {
          // Best-effort — the user already wants out. Worst case: the code
          // expires naturally in <10 min.
        }
        router.push('/');
      }}
      onApproved={(projectName) => {
        addToast('success', 'Tool connected');
        setSuccessProject(projectName);
      }}
      onSwitchAccount={async () => {
        try {
          await signOut();
          await signIn();
        } catch (err) {
          addToast('error', err instanceof Error ? err.message : 'Sign-in failed');
        }
      }}
    />
  );
}

interface SignedInConfirmViewProps {
  userCode: string;
  userEmail: string;
  userPhotoURL: string | null;
  onCancel: () => void;
  onApproved: (projectName: string) => void;
  onSwitchAccount: () => void;
}

/**
 * Sub-view that owns the lookup + match SWR calls and the confirm panel
 * lifecycle. Split out so the top-level component stays a thin state-branch
 * router and the test surface for the data-fetching path is easy to mock.
 */
export function SignedInConfirmView({
  userCode,
  userEmail,
  userPhotoURL,
  onCancel,
  onApproved,
  onSwitchAccount,
}: SignedInConfirmViewProps) {
  const lookup = useSWR(['connect-lookup', userCode], () => api.auth.connect.lookup({ user_code: userCode }), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  const repoUrl = lookup.data?.repo_url ?? '';
  const matches = useSWR(
    repoUrl ? ['connect-match', repoUrl] : null,
    () => api.projects.match({ repo_url: repoUrl }),
    { revalidateOnFocus: false },
  );
  const projects = useSWR('projects', () => api.projects.list(), { revalidateOnFocus: false });

  if (lookup.isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (lookup.error || !lookup.data) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Code not found</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          The code you entered is unknown, expired, or already used. Start over from your IDE.
        </p>
        <button
          onClick={onCancel}
          className="mt-6 inline-flex items-center rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800"
        >
          Back to dashboard
        </button>
      </div>
    );
  }

  return (
    <ConfirmPanel
      userCode={userCode}
      meta={lookup.data}
      matches={matches.data?.matches ?? []}
      allProjects={projects.data?.projects ?? []}
      userEmail={userEmail}
      userPhotoURL={userPhotoURL}
      onCancel={onCancel}
      onApproved={onApproved}
      onSwitchAccount={onSwitchAccount}
      onNewProjectCreated={() => projects.mutate()}
    />
  );
}

/**
 * Pure helper for the countdown ticker. Returns a friendly `"9m 42s"` string
 * (or `"0m 00s"` once the deadline has passed). Exported for tests.
 */
export function formatExpiryCountdown(expiresAtIso: string, nowMs: number): string {
  const remaining = Math.max(0, Date.parse(expiresAtIso) - nowMs);
  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/** Pure helper exported for tests. */
export function isExpired(expiresAtIso: string, nowMs: number): boolean {
  return Date.parse(expiresAtIso) <= nowMs;
}

/**
 * Tick a state value once per second from a `useEffect`. Returns the current
 * timestamp in ms. Exported so the confirm panel can read live countdown
 * state without owning a custom-hooked timer.
 */
export function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
