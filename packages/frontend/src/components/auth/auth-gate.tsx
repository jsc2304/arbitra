'use client';

import { useAuth } from '../../providers/auth-provider';
import { useLauncher } from '../../providers/launcher-provider';
import Image from 'next/image';
import { ParticleCanvas } from '../launcher/particle-canvas';
import LoadingSpinner from '../shared/loading-spinner';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, signIn } = useAuth();
  const launcher = useLauncher();

  const handleSignIn = async () => {
    await signIn();
    // After sign-in, open the launcher so the user picks where to go
    launcher.open();
  };

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="relative flex h-[calc(100vh-4rem)] items-center justify-center overflow-hidden">
        {/* Particle background */}
        <ParticleCanvas active={true} />

        {/* Frosted backdrop */}
        <div className="absolute inset-0 bg-surface-raised/20 dark:bg-surface-raised/40 backdrop-blur-[2px]" />

        {/* Sign-in card with glassmorphism */}
        <div className="relative z-10 text-center max-w-lg px-6">
          <div className="rounded-2xl bg-surface-raised/60 dark:bg-surface-raised/50 backdrop-blur-xl border border-white/30 dark:border-border-subtle/40 shadow-lg shadow-accent/5 dark:shadow-black/20 p-8 md:p-10">
            <Image src="/icon-512.png" alt="" className="h-20 w-auto mx-auto mb-1" width={512} height={512} />
            <h1 className="text-3xl font-extrabold text-corp-dark dark:text-white mb-2">Arbitra</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">
              The Agent Management System
            </p>
            <button
              onClick={handleSignIn}
              className="inline-flex items-center gap-3 rounded-lg bg-surface-raised/80 border border-gray-300/60 dark:border-gray-600/60 px-6 py-3 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-surface-raised dark:hover:bg-gray-700 transition-colors"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              Sign in with Google
            </button>
            <p className="mt-6 text-xs text-gray-400 dark:text-gray-500">
              Use your Google Workspace account to sign in.
            </p>
          </div>

          {/* Tagline */}
          <div className="mt-8 rounded-xl bg-surface-raised/30 backdrop-blur-md border border-white/20 dark:border-border-subtle/30 px-6 py-5 max-w-md mx-auto">
            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400 italic">
              &ldquo;Arbitra is not a chatbot, not a Jira replacement, and not just another code review tool.
              It combines multi-model AI reviews, configurable rule evaluation, evidence management,
              and organizational knowledge capture into one system&nbsp;&mdash; with the human always in control
              of the final decision.&rdquo;
            </p>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
