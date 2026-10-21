'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { DashboardHeader } from '../../components/dashboard/dashboard-header';
import { MetricsSummary } from '../../components/dashboard/metrics-summary';
import { AttentionNeededSection } from '../../components/dashboard/attention-needed-section';
import { MyCasesSection } from '../../components/dashboard/my-cases-section';
import { RecentActivityFeed } from '../../components/dashboard/recent-activity-feed';
import { OnboardingChecklist } from '../../components/dashboard/onboarding-checklist';
import { TipsSection } from '../../components/dashboard/tips-section';
import { useDashboard } from '../../hooks/use-dashboard';
import { api } from '../../lib/api-client';
import LoadingSpinner from '../../components/shared/loading-spinner';

export default function DashboardPage() {
  const { myCases, attentionCases, staleCases, metrics, decidedCount, recentActivity, isLoading, error } = useDashboard();
  const { data: projectsData } = useSWR('projects', () => api.projects.list());
  const hasProjects = (projectsData?.projects?.length ?? 0) > 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <LoadingSpinner size="md" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  const errorMessage = error instanceof Error ? error.message : error ? String(error) : null;

  const totalOpen = metrics?.total_cases ?? 0;
  const approvalRate = Math.round(metrics?.approval_rate ?? 0);

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-8">
      <DashboardHeader />

      {projectsData && !hasProjects && (
        <div className="mb-6 rounded-lg border border-gray-200 dark:border-border-subtle border-l-4 border-l-accent bg-surface-raised p-5">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Welcome to Arbitra</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Set up your first project to start managing AI-assisted development.
          </p>
          <Link
            href="/setup/new-project"
            className="mt-3 inline-flex items-center gap-2 rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 transition-colors"
          >
            Create Your First Project
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
          </Link>
        </div>
      )}

      {errorMessage && (
        <div className="mb-6 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3">
          <p className="text-sm text-red-700 dark:text-red-400">
            Failed to load some dashboard data. {errorMessage}
          </p>
        </div>
      )}

      <OnboardingChecklist />

      <MetricsSummary
        myCasesCount={myCases.length}
        attentionCount={attentionCases.length}
        approvalRate={approvalRate}
        totalOpen={totalOpen}
        staleCount={staleCases.length}
        decidedCount={decidedCount}
      />

      {/* Two-column layout: attention + activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <div className="lg:col-span-2">
          <AttentionNeededSection cases={attentionCases} />
        </div>
        <div className="lg:col-span-1">
          <RecentActivityFeed items={recentActivity} />
        </div>
      </div>

      <MyCasesSection cases={myCases} />

      <TipsSection />
    </div>
  );
}
