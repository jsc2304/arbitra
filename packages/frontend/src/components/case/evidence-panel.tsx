'use client';

import { useState } from 'react';
import Image from 'next/image';
import useSWR from 'swr';
import type { EvidenceType } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { getEvidenceLabel, getEvidenceDescription } from '../../lib/evidence-labels';
import { useToast } from '../../providers/toast-provider';
import { useEscapeKey } from '../../hooks/use-escape-key';
import { RelativeTime } from '../shared/relative-time';

interface EvidencePanelProps {
  caseId: string;
}

const typeStyles: Record<string, string> = {
  unit_test_result: 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400',
  integration_test_result: 'bg-secondary-100 dark:bg-secondary-900/50 text-secondary-700 dark:text-secondary-400',
  ci_result: 'bg-violet-100 dark:bg-violet-900/50 text-violet-700 dark:text-violet-400',
  lint_result: 'bg-cyan-100 dark:bg-cyan-900/50 text-cyan-700 dark:text-cyan-400',
  runtime_log: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300',
  screenshot: 'bg-pink-100 dark:bg-pink-900/50 text-pink-700 dark:text-pink-400',
  diff_snapshot: 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400',
  manual_confirmation: 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-400',
  benchmark_result: 'bg-teal-100 dark:bg-teal-900/50 text-teal-700 dark:text-teal-400',
  external_reference: 'bg-slate-100 dark:bg-slate-900/50 text-slate-700 dark:text-slate-400',
};

function EvidenceTypeBadge({ type }: { type: EvidenceType }) {
  const className = typeStyles[type] ?? 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300';
  const description = getEvidenceDescription(type);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
      title={description || undefined}
    >
      {getEvidenceLabel(type)}
    </span>
  );
}

function RequirementRow({
  type,
  label,
  variant,
  present,
}: {
  type: string;
  label: string;
  variant: 'required' | 'optional';
  present: boolean;
}) {
  const isRequired = variant === 'required';
  return (
    <li
      aria-label={`${label} — ${isRequired ? 'required' : 'optional'}, ${present ? 'present' : 'pending'}`}
      className={`flex items-center justify-between gap-3 px-2 rounded ${
        isRequired ? 'py-1.5' : 'py-1'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <EvidenceTypeBadge type={type as EvidenceType} />
        <span
          className={`truncate ${
            isRequired
              ? 'text-sm text-gray-900 dark:text-gray-100'
              : 'text-xs text-gray-600 dark:text-gray-400'
          }`}
        >
          {label}
        </span>
      </div>
      {present ? (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400 flex-shrink-0">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          Present
        </span>
      ) : isRequired ? (
        <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300 flex-shrink-0">
          Pending
        </span>
      ) : (
        <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
          Not provided
        </span>
      )}
    </li>
  );
}

const evidenceTypes: EvidenceType[] = [
  'unit_test_result',
  'integration_test_result',
  'ci_result',
  'lint_result',
  'runtime_log',
  'screenshot',
  'diff_snapshot',
  'manual_confirmation',
  'benchmark_result',
  'external_reference',
];

export function EvidencePanel({ caseId }: EvidencePanelProps) {
  const { data, error, isLoading, mutate } = useSWR(
    ['evidence', caseId],
    () => api.cases.evidence(caseId),
  );
  const { data: requirements, isLoading: requirementsLoading, error: requirementsError } = useSWR(
    ['case-evidence-requirements', caseId],
    () => api.cases.evidenceRequirements(caseId),
  );
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formType, setFormType] = useState('manual_confirmation');
  const [formSummary, setFormSummary] = useState('');
  const [formArtifactRef, setFormArtifactRef] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const { addToast } = useToast();

  useEscapeKey(() => setLightboxSrc(null), !!lightboxSrc);

  const isFileType = formType === 'screenshot' || formType === 'runtime_log' || formType === 'diff_snapshot';

  function handleFileSelect(f: File) {
    setFile(f);
    if (f.type.startsWith('image/')) {
      const url = URL.createObjectURL(f);
      setFilePreview(url);
    } else {
      setFilePreview(null);
    }
    if (!formSummary.trim()) {
      setFormSummary(f.name);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFileSelect(f);
  }

  function resetForm() {
    setFormSummary('');
    setFormArtifactRef('');
    setFormType('manual_confirmation');
    setFile(null);
    if (filePreview) URL.revokeObjectURL(filePreview);
    setFilePreview(null);
    setShowForm(false);
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!formSummary.trim()) return;
    setSubmitting(true);
    try {
      // In demo mode, file is stored as a data URL in artifact_ref
      let artifactRef = formArtifactRef.trim() || undefined;
      if (file) {
        artifactRef = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });
      }

      await api.cases.registerEvidence(caseId, {
        type: formType,
        source_type: 'manual',
        summary: formSummary.trim(),
        artifact_ref: artifactRef,
        machine_readable: false,
      });
      addToast('success', 'Evidence registered');
      resetForm();
      mutate();
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        Loading evidence...
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg px-4 py-8 text-center text-sm text-red-600">
        Failed to load evidence: {error.message}
      </div>
    );
  }

  const evidence = data?.evidence ?? [];
  const required = requirements?.required ?? [];
  const optional = requirements?.optional ?? [];
  const present = requirements?.present ?? [];
  // 'present' may contain types outside required ∪ optional; we only render rows for declared requirements.
  const presentSet = new Set(present);
  const showExpected =
    requirementsLoading || requirementsError || required.length > 0 || optional.length > 0;

  return (
    <>
    {lightboxSrc && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
        onClick={() => setLightboxSrc(null)}
      >
        <button
          className="absolute top-4 right-4 text-white/80 hover:text-white text-2xl font-bold"
          onClick={() => setLightboxSrc(null)}
        >
          &times;
        </button>
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
        <Image
          src={lightboxSrc}
          alt="Evidence preview"
          className="max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl object-contain"
          width={1200}
          height={900}
          onClick={(e) => e.stopPropagation()}
          unoptimized
        />
      </div>
    )}
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg">
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Evidence ({evidence.length})
          </h3>
          <span
            className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 text-[10px] font-bold cursor-help"
            title="Evidence consists of verifiable artifacts that support or refute claims about the case: test results, CI outputs, logs, screenshots, or manual confirmations. The evidence policy defines what types are required based on risk level and validation track."
          >
            ?
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowForm(!showForm)}
            className="inline-flex items-center rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 transition-colors"
          >
            + Register Evidence
          </button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={handleRegister} className="border-b border-gray-200 dark:border-border-subtle px-4 py-3 bg-surface-base dark:bg-surface-base/50 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Evidence Type</label>
              <select
                value={formType}
                onChange={(e) => {
                  setFormType(e.target.value);
                  setFile(null);
                  if (filePreview) URL.revokeObjectURL(filePreview);
                  setFilePreview(null);
                }}
                className="w-full rounded-md border border-gray-300 dark:border-border-default px-2.5 py-1.5 text-sm bg-input-bg dark:text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent"
              >
                {evidenceTypes.map((t) => (
                  <option key={t} value={t}>{getEvidenceLabel(t)}</option>
                ))}
              </select>
            </div>
            {!isFileType && (
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Artifact Reference <span className="text-gray-400 dark:text-gray-500 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={formArtifactRef}
                  onChange={(e) => setFormArtifactRef(e.target.value)}
                  placeholder="URL or file path"
                  className="w-full rounded-md border border-gray-300 dark:border-border-default px-2.5 py-1.5 text-sm bg-input-bg dark:text-gray-200 dark:placeholder-gray-500 focus:border-accent focus:ring-1 focus:ring-accent"
                />
              </div>
            )}
          </div>

          {isFileType && (
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">File</label>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = formType === 'screenshot' ? 'image/*' : '*/*';
                  input.onchange = () => {
                    const f = input.files?.[0];
                    if (f) handleFileSelect(f);
                  };
                  input.click();
                }}
                className={`relative flex flex-col items-center justify-center rounded-md border-2 border-dashed px-4 py-4 cursor-pointer transition-colors ${
                  dragOver
                    ? 'border-accent bg-accent-light'
                    : file
                      ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/50'
                      : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500 bg-surface-raised'
                }`}
              >
                {file ? (
                  <div className="flex items-center gap-3 w-full">
                    {filePreview && (
                      <Image src={filePreview} alt="Preview" className="h-12 w-12 rounded object-cover flex-shrink-0" width={48} height={48} unoptimized />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{file.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{(file.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFile(null);
                        if (filePreview) URL.revokeObjectURL(filePreview);
                        setFilePreview(null);
                      }}
                      className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-sm"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <>
                    <svg className="h-8 w-8 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                    </svg>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                      Drop a file here or <span className="text-accent-700 dark:text-accent-300 font-medium">click to browse</span>
                    </p>
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      {formType === 'screenshot' ? 'PNG, JPG, GIF, WebP' : 'Any file type'}
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Summary</label>
            <textarea
              value={formSummary}
              onChange={(e) => setFormSummary(e.target.value)}
              rows={2}
              placeholder="Describe the evidence — e.g. 'All 87 unit tests passing, 92% coverage'"
              className="w-full rounded-md border border-gray-300 dark:border-border-default px-2.5 py-1.5 text-sm bg-input-bg dark:text-gray-200 dark:placeholder-gray-500 focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={resetForm}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !formSummary.trim()}
              className="rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 transition-colors"
            >
              {submitting ? 'Registering...' : 'Register'}
            </button>
          </div>
        </form>
      )}

      {showExpected && (
        <div className="border-b border-gray-200 dark:border-border-subtle px-4 py-3 space-y-3">
          {requirementsLoading ? (
            <div className="space-y-2">
              <div className="h-3 w-20 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
              <div className="h-7 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
              <div className="h-7 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
            </div>
          ) : requirementsError ? (
            <div className="text-sm text-red-600">
              Failed to load expected evidence: {requirementsError.message}
            </div>
          ) : (
            <>
              {required.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">
                    Required
                  </p>
                  <ul className="space-y-1">
                    {required.map((type) => (
                      <RequirementRow
                        key={type}
                        type={type}
                        label={getEvidenceLabel(type as EvidenceType)}
                        variant="required"
                        present={presentSet.has(type)}
                      />
                    ))}
                  </ul>
                </div>
              )}
              {optional.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1.5">
                    Optional
                  </p>
                  <ul className="space-y-1">
                    {optional.map((type) => (
                      <RequirementRow
                        key={type}
                        type={type}
                        label={getEvidenceLabel(type as EvidenceType)}
                        variant="optional"
                        present={presentSet.has(type)}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {evidence.length === 0 ? (
        <div className="px-6 py-8 text-center">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
            No evidence attached yet
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
            Evidence is collected automatically from CI pipelines and webhooks, or registered manually.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {evidence.map((ev) => (
            <li key={ev.evidence_id} data-entity-id={ev.evidence_id} className="px-4 py-3 rounded transition-colors">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <EvidenceTypeBadge type={ev.type} />
                  <span
                    className="text-sm text-gray-900 dark:text-gray-100 truncate"
                    title={ev.summary ?? ev.type?.replace(/_/g, ' ') ?? 'Unknown type'}
                  >
                    {ev.summary ?? ev.type?.replace(/_/g, ' ') ?? 'Unknown type'}
                  </span>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 text-xs text-gray-500 dark:text-gray-400">
                  <span className="capitalize">{ev.source_type}</span>
                  <span>{ev.validation_track}</span>
                  <RelativeTime timestamp={ev.created_at} />
                </div>
              </div>
              {ev.artifact_ref && (
                ev.artifact_ref.startsWith('data:image/') ? (
                  <div className="mt-2 pl-2">
                    {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
                    <Image
                      src={ev.artifact_ref}
                      alt={ev.summary ?? 'Screenshot'}
                      className="max-h-32 rounded border border-gray-200 dark:border-border-subtle cursor-pointer hover:ring-2 hover:ring-accent transition-shadow"
                      width={256}
                      height={128}
                      onClick={() => setLightboxSrc(ev.artifact_ref!)}
                      title="Click to enlarge"
                      unoptimized
                    />
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500 font-mono truncate pl-2">
                    {ev.artifact_ref}
                  </p>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
    </>
  );
}
