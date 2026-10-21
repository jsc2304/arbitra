import type { EvidenceType } from '@arbitra/shared';

export type EvidenceCategory = 'automated' | 'manual';

interface EvidenceTypeMeta {
  label: string;
  description: string;
  category: EvidenceCategory;
}

const evidenceTypeMeta: Record<EvidenceType, EvidenceTypeMeta> = {
  ci_result: {
    label: 'Build Result',
    description: 'Confirms the code compiles and builds without errors',
    category: 'automated',
  },
  unit_test_result: {
    label: 'Test Results',
    description: 'Unit tests have been run and passed',
    category: 'automated',
  },
  integration_test_result: {
    label: 'Integration Test Results',
    description: 'End-to-end or integration tests passed',
    category: 'automated',
  },
  lint_result: {
    label: 'Lint / Code Quality',
    description: 'Linting and code style checks passed',
    category: 'automated',
  },
  runtime_log: {
    label: 'Runtime Verification',
    description: 'Application was started and tested at runtime',
    category: 'manual',
  },
  screenshot: {
    label: 'Screenshot Proof',
    description: 'Visual evidence of correct behavior',
    category: 'manual',
  },
  diff_snapshot: {
    label: 'Code Diff',
    description: 'Snapshot of the code changes for review',
    category: 'automated',
  },
  manual_confirmation: {
    label: 'Manual Verification',
    description: 'A human confirmed the changes work correctly',
    category: 'manual',
  },
  benchmark_result: {
    label: 'Performance Benchmark',
    description: 'Performance metrics measured before and after changes',
    category: 'automated',
  },
  external_reference: {
    label: 'External Reference',
    description: 'Link to an external resource or documentation',
    category: 'manual',
  },
  pr_merged: {
    label: 'PR Merged',
    description: 'Synthetic evidence recorded when a linked pull request was merged',
    category: 'automated',
  },
  detection_report: {
    label: 'Detection Report',
    description: 'Structured payload from an Arbitra Code Intelligence detector',
    category: 'automated',
  },
};

export function getEvidenceLabel(type: EvidenceType | string | null | undefined): string {
  if (!type) return 'Unknown type';
  return (
    evidenceTypeMeta[type as EvidenceType]?.label ??
    type
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

export function getEvidenceDescription(type: EvidenceType | string | null | undefined): string {
  if (!type) return '';
  return evidenceTypeMeta[type as EvidenceType]?.description ?? '';
}

export function getEvidenceCategory(
  type: EvidenceType | string | null | undefined,
): EvidenceCategory | undefined {
  if (!type) return undefined;
  return evidenceTypeMeta[type as EvidenceType]?.category;
}
