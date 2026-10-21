'use client';

import { useState, useEffect, useId } from 'react';
import type { Case, RiskLevel, Priority, ValidationTrack, CaseType } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useEscapeKey } from '../../hooks/use-escape-key';
import { Button } from '../ui/button';

const CASE_TYPE_LABELS: Record<string, string> = {
  ticket_implementation: 'Ticket Implementation',
  bugfix: 'Bug Fix',
  refactoring: 'Refactoring',
  pr_review: 'PR Review',
  manual_verification: 'Manual Verification',
  security_review: 'Security Review',
  other: 'Other',
};

interface EditCaseModalProps {
  caseData: Case;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function EditCaseModal({ caseData, open, onClose, onSaved }: EditCaseModalProps) {
  const [editTitle, setEditTitle] = useState(caseData.title);
  const [editDescription, setEditDescription] = useState(caseData.description);
  const [editRiskLevel, setEditRiskLevel] = useState<RiskLevel>(caseData.risk_level);
  const [editPriority, setEditPriority] = useState<Priority>(caseData.priority);
  const [editTrack, setEditTrack] = useState<ValidationTrack>(caseData.validation_track);
  const [editCaseType, setEditCaseType] = useState<CaseType | undefined>(caseData.case_type);
  const [editProjectId, setEditProjectId] = useState(caseData.project_id);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Stable base id for this modal instance — suffixed per field below so the
  // dialog heading and every control get a unique, generated id without a
  // separate useId() call each (mirrors the create-case-modal dialogTitleId
  // pattern).
  const uid = useId();
  const dialogTitleId = `${uid}-heading`;
  const titleFieldId = `${uid}-title`;
  const descriptionFieldId = `${uid}-description`;
  const projectIdFieldId = `${uid}-project-id`;
  const riskLevelFieldId = `${uid}-risk-level`;
  const priorityFieldId = `${uid}-priority`;
  const validationTrackFieldId = `${uid}-validation-track`;
  const caseTypeFieldId = `${uid}-case-type`;

  useEscapeKey(() => { onClose(); setSaveError(null); }, open);

  // Re-seed form state only when the modal transitions to open, so that
  // background SWR refreshes of `caseData` (e.g. pending_merge auto-sync,
  // webhook-driven mutations) do not clobber the user's mid-typing edits.
  // `caseData` is intentionally omitted from deps for this reason.
  useEffect(() => {
    if (!open) return;
    setEditTitle(caseData.title);
    setEditDescription(caseData.description);
    setEditRiskLevel(caseData.risk_level);
    setEditPriority(caseData.priority);
    setEditTrack(caseData.validation_track);
    setEditCaseType(caseData.case_type);
    setEditProjectId(caseData.project_id);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleSaveCore() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.cases.update(caseData.case_id, {
        title: editTitle.trim(),
        description: editDescription.trim(),
        risk_level: editRiskLevel,
        priority: editPriority,
        validation_track: editTrack,
        case_type: editCaseType,
        project_id: editProjectId.trim(),
      });
      onClose();
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) { onClose(); setSaveError(null); } }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={dialogTitleId}
    >
      <div className="bg-surface-overlay rounded-lg shadow-xl w-full max-w-xl mx-4 max-h-[85vh] overflow-y-auto">
        <div className="border-b border-gray-200 dark:border-border-subtle px-6 py-4 flex items-center justify-between">
          <h2 id={dialogTitleId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edit Case</h2>
          <button
            onClick={() => { onClose(); setSaveError(null); }}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Title */}
          <div>
            <label htmlFor={titleFieldId} className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Title</label>
            <input
              id={titleFieldId}
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Description */}
          <div>
            <label htmlFor={descriptionFieldId} className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <textarea
              id={descriptionFieldId}
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Project ID */}
          <div>
            <label htmlFor={projectIdFieldId} className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Project ID</label>
            <input
              id={projectIdFieldId}
              type="text"
              value={editProjectId}
              onChange={(e) => setEditProjectId(e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm font-mono text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Row: Risk Level + Priority */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor={riskLevelFieldId} className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Risk Level</label>
              <select
                id={riskLevelFieldId}
                value={editRiskLevel}
                onChange={(e) => setEditRiskLevel(e.target.value as RiskLevel)}
                className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <label htmlFor={priorityFieldId} className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Priority</label>
              <select
                id={priorityFieldId}
                value={editPriority}
                onChange={(e) => setEditPriority(e.target.value as Priority)}
                className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>

          {/* Row: Validation Track + Case Type */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor={validationTrackFieldId} className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Validation Track</label>
              <select
                id={validationTrackFieldId}
                value={editTrack}
                onChange={(e) => setEditTrack(e.target.value as ValidationTrack)}
                className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="direct">Direct</option>
                <option value="manual">Manual</option>
              </select>
            </div>
            <div>
              <label htmlFor={caseTypeFieldId} className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Case Type</label>
              <select
                id={caseTypeFieldId}
                value={editCaseType ?? ''}
                onChange={(e) => setEditCaseType((e.target.value || undefined) as CaseType | undefined)}
                className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="">Not set</option>
                {Object.entries(CASE_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Risk level change warning */}
          {editRiskLevel !== caseData.risk_level && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 px-3 py-2.5">
              <svg className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Changing risk level from <strong>{caseData.risk_level}</strong> to <strong>{editRiskLevel}</strong> will be recorded in the audit trail.
                {(caseData.risk_level === 'high' || caseData.risk_level === 'critical') &&
                 (editRiskLevel === 'low' || editRiskLevel === 'medium') &&
                  ' Downgrading from high/critical triggers a risk-downgrade audit finding.'}
              </p>
            </div>
          )}

          {saveError && (
            <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/50 px-3 py-2 text-sm text-red-700 dark:text-red-400">
              {saveError}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-border-subtle px-6 py-4 flex justify-end gap-3">
          {/* Cancel is text-only (no border, no hover bg) — override the ghost
              hover background to preserve the original look. */}
          <Button
            variant="ghost"
            onClick={() => { onClose(); setSaveError(null); }}
            className="text-gray-600 dark:text-gray-400 hover:bg-transparent dark:hover:bg-transparent hover:text-gray-800 dark:hover:text-gray-200"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveCore}
            disabled={saving || !editTitle.trim()}
            loading={saving}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>
  );
}
