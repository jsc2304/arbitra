'use client';

import { useEffect, useMemo } from 'react';
import type { Evidence, User } from '@arbitra/shared';
import { getEvidenceLabel } from '../../lib/evidence-labels';
import { useUserMap } from '../../hooks/use-users';
import { UserDisplay } from '../shared/user-display';
import { ActorSignature } from '../shared/actor-signature';
import { RelativeTime } from '../shared/relative-time';

const typeColors: Record<string, string> = {
  unit_test_result: 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400',
  integration_test_result: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400',
  ci_result: 'bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-400',
  lint_result: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-400',
  runtime_log: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  screenshot: 'bg-pink-100 text-pink-700 dark:bg-pink-950/50 dark:text-pink-400',
  diff_snapshot: 'bg-secondary-100 text-secondary-700 dark:bg-secondary-950/50 dark:text-secondary-400',
  manual_confirmation: 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400',
};

const sourceTypeLabels: Record<string, string> = {
  automated: 'Automated',
  manual: 'Manual',
  webhook: 'Webhook',
  agent: 'Agent',
};

interface EvidenceDetailPanelProps {
  evidence: Evidence | null;
  onClose: () => void;
}

export function EvidenceDetailPanel({ evidence, onClose }: EvidenceDetailPanelProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className={`fixed inset-0 z-40 ${evidence ? '' : 'pointer-events-none'}`}>
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/30 transition-opacity duration-300 ${evidence ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      {/* Panel */}
      <div
        className={`absolute inset-y-0 right-0 w-[480px] max-w-full bg-surface-raised shadow-xl border-l border-gray-200 dark:border-border-subtle transition-transform duration-300 ease-out ${evidence ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {evidence && <PanelContent evidence={evidence} onClose={onClose} />}
      </div>
    </div>
  );
}

function PanelContent({ evidence, onClose }: { evidence: Evidence; onClose: () => void }) {
  const typeLabel = getEvidenceLabel(evidence.type);
  const badgeColor = typeColors[evidence.type] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';

  const userIds = useMemo(() => [evidence.created_by], [evidence.created_by]);
  const users = useUserMap(userIds);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-border-subtle px-5 py-4">
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${badgeColor}`}>
          {typeLabel}
        </span>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 hover:bg-surface-base dark:hover:bg-border-subtle transition-colors"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        <CommonSections evidence={evidence} users={users} />
        <TypeSpecificSection evidence={evidence} users={users} />
      </div>
    </div>
  );
}

function CommonSections({
  evidence,
  users,
}: {
  evidence: Evidence;
  users: Record<string, User>;
}) {
  return (
    <>
      {evidence.summary && (
        <Section title="Summary">
          <p className="text-base leading-relaxed text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
            {evidence.summary}
          </p>
        </Section>
      )}

      <div className="grid grid-cols-2 gap-4">
        <MetaItem label="Source Type">
          <span className="inline-flex items-center rounded bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300">
            {sourceTypeLabels[evidence.source_type] ?? evidence.source_type}
          </span>
        </MetaItem>

        <MetaItem label="Submitted By">
          <span className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
            <UserDisplay userId={evidence.created_by} users={users} showAvatar />
            <ActorSignature meta={evidence.actor_metadata} />
          </span>
        </MetaItem>

        <MetaItem label="Timestamp">
          <RelativeTime
            timestamp={evidence.created_at}
            className="text-sm text-gray-700 dark:text-gray-300"
          />
        </MetaItem>
      </div>

      {evidence.artifact_ref && (
        <Section title="Artifact Reference">
          <code className="block text-xs font-mono text-gray-700 dark:text-gray-300 bg-surface-base dark:bg-surface-base rounded-lg px-3 py-2 break-all">
            {evidence.artifact_ref}
          </code>
        </Section>
      )}
    </>
  );
}

function TypeSpecificSection({ evidence, users }: { evidence: Evidence; users: Record<string, User> }) {
  const summary = evidence.summary ?? '';

  switch (evidence.type) {
    case 'diff_snapshot':
      return (
        <Section title="Diff">
          <pre className="bg-gray-950 text-green-400 font-mono text-xs p-4 rounded-lg overflow-x-auto">
            <code>{summary}</code>
          </pre>
        </Section>
      );

    case 'ci_result': {
      const passed = /passed/i.test(summary);
      const failed = /failed/i.test(summary);
      const isDuplicate = (evidence.summary ?? '').trim() === summary.trim();
      if (isDuplicate && !passed && !failed) return null;
      return (
        <Section title="Output">
          {(passed || failed) && (
            <div className="mb-3">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
                  passed
                    ? 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400'
                    : 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400'
                }`}
              >
                {passed ? 'Passed' : 'Failed'}
              </span>
            </div>
          )}
          {!isDuplicate && <TerminalBlock content={summary} />}
        </Section>
      );
    }

    case 'unit_test_result':
    case 'integration_test_result': {
      const passed = /passed/i.test(summary);
      const failed = /failed/i.test(summary);
      const isDuplicate = (evidence.summary ?? '').trim() === summary.trim();
      if (isDuplicate && !passed && !failed) return null;
      return (
        <Section title="Test Result">
          {(passed || failed) && (
            <div className="mb-3">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
                  passed
                    ? 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400'
                    : 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400'
                }`}
              >
                {passed ? 'Passed' : 'Failed'}
              </span>
            </div>
          )}
          {!isDuplicate && <TerminalBlock content={summary} />}
        </Section>
      );
    }

    case 'screenshot':
      return (
        <Section title="Screenshot">
          <div className="bg-gray-100 dark:bg-gray-800 rounded-lg h-48 flex items-center justify-center">
            <div className="text-center text-gray-400 dark:text-gray-500">
              <svg
                className="mx-auto h-10 w-10 mb-2"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z"
                />
              </svg>
              <p className="text-xs">Screenshot preview available after deployment</p>
            </div>
          </div>
        </Section>
      );

    case 'manual_confirmation':
      return (
        <Section title="Manual Confirmation">
          <blockquote className="border-l-4 border-orange-300 dark:border-orange-600 bg-orange-50 dark:bg-orange-950/30 rounded-r-lg px-4 py-3">
            <p className="text-sm text-gray-700 dark:text-gray-300 italic whitespace-pre-wrap">{summary}</p>
          </blockquote>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <MetaItem label="Confirmed By">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                <UserDisplay userId={evidence.created_by} users={users} />
              </span>
            </MetaItem>
            <MetaItem label="Confirmed At">
              <RelativeTime
                timestamp={evidence.created_at}
                className="text-sm text-gray-700 dark:text-gray-300"
              />
            </MetaItem>
          </div>
        </Section>
      );

    case 'runtime_log':
      return (
        <Section title="Runtime Log">
          <TerminalBlock content={summary} />
        </Section>
      );

    case 'lint_result':
      return (
        <Section title="Lint Output">
          <TerminalBlock content={summary} />
        </Section>
      );

    default:
      return null;
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">{title}</h3>
      {children}
    </div>
  );
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="block text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-0.5">{label}</span>
      {children}
    </div>
  );
}

function TerminalBlock({ content }: { content: string }) {
  return (
    <pre className="bg-gray-950 text-gray-300 font-mono text-xs p-4 rounded-lg overflow-x-auto whitespace-pre-wrap">
      <code>{content}</code>
    </pre>
  );
}
