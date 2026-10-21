'use client';

import { useState, useEffect, useRef, useId } from 'react';
import Image from 'next/image';
import type { SourceType, ValidationTrack, RiskLevel, Priority, CaseTemplate, Project, Repository } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';
import { useEscapeKey } from '../../hooks/use-escape-key';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface CreateCaseModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

const labelClasses = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

export function CreateCaseModal({ open, onClose, onCreated }: CreateCaseModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('manual');
  const [validationTrack, setValidationTrack] = useState<ValidationTrack>('direct');
  const [riskLevel, setRiskLevel] = useState<RiskLevel>('low');
  const [priority, setPriority] = useState<Priority>('normal');
  const [jiraRefs, setJiraRefs] = useState('');
  const [projectId, setProjectId] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [branch, setBranch] = useState('');
  const [prRef, setPrRef] = useState('');
  const [attachments, setAttachments] = useState<{ file: File; preview: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addToast } = useToast();
  const [templates, setTemplates] = useState<CaseTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);

  // Keep a ref for repositoryId so the second effect can read it without depending on it
  const repositoryIdRef = useRef(repositoryId);
  repositoryIdRef.current = repositoryId;

  const dialogTitleId = useId();

  // Reset every draft field when the modal transitions to open, so a
  // canceled draft (or the leftover selection from the previous session)
  // never resurfaces on reopen — Cancel must be a hard discard, not a
  // pause. Declared before the templates/projects fetch effect below so
  // the reset always runs first on the same open transition, leaving the
  // auto-select-single-project behavior in that effect intact.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setSourceType('manual');
    setValidationTrack('direct');
    setRiskLevel('low');
    setPriority('normal');
    setJiraRefs('');
    setProjectId('');
    setRepositoryId('');
    setBranch('');
    setPrRef('');
    setSelectedTemplate('');
    setAttachments((prev) => {
      prev.forEach((a) => { if (a.preview) URL.revokeObjectURL(a.preview); });
      return [];
    });
    setError(null);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    api.caseTemplates.list().then((res) => setTemplates(res.templates)).catch(() => {});
    api.projects.list().then(({ projects: p }) => {
      setProjects(p);
      if (p.length === 1 && !projectId) {
        setProjectId(p[0]!.project_id);
      }
    }).catch(() => {});
  }, [open, projectId]);

  useEffect(() => {
    if (!projectId) {
      setRepositories([]);
      setRepositoryId('');
      return;
    }
    api.projects.repositories(projectId).then(({ repositories: r }) => {
      setRepositories(r);
      if (r.length === 1) {
        setRepositoryId(r[0]!.repository_id);
      } else if (!r.find((repo) => repo.repository_id === repositoryIdRef.current)) {
        setRepositoryId('');
      }
    }).catch(() => {
      setRepositories([]);
    });
  }, [projectId]);

  function applyTemplate(templateId: string) {
    setSelectedTemplate(templateId);
    if (!templateId) {
      // Reset to defaults when deselecting template
      setRiskLevel('low');
      setPriority('normal');
      setValidationTrack('direct');
      return;
    }
    const tmpl = templates.find((t) => t.template_id === templateId);
    if (!tmpl) return;
    const d = tmpl.defaults;
    setRiskLevel(d.risk_level ?? 'low');
    setPriority(d.priority ?? 'normal');
    setValidationTrack(d.validation_track ?? 'direct');
    if (d.title_prefix && !title) setTitle(d.title_prefix);
    if (d.description_template && !description) setDescription(d.description_template);
  }

  useEscapeKey(onClose, open);

  if (!open) return null;

  function handleFileSelect(files: FileList | null) {
    if (!files) return;
    const newFiles = Array.from(files).map((file) => ({
      file,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
    }));
    setAttachments((prev) => [...prev, ...newFiles]);
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => {
      const removed = prev[index];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (!projectId) {
      setError('Project is required');
      return;
    }
    if (!repositoryId) {
      setError('Repository is required');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const created = await api.cases.create({
        title: title.trim(),
        description: description.trim(),
        source_type: sourceType,
        validation_track: validationTrack,
        risk_level: riskLevel,
        priority,
        project_id: projectId,
        repository_id: repositoryId,
        current_branch: branch.trim() || undefined,
        current_pr_ref: prRef.trim() || undefined,
        jira_refs: jiraRefs
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });

      if (attachments.length > 0) {
        const attachmentPayload = await Promise.all(
          attachments.map(async (att) => {
            const dataUrl = await fileToDataUrl(att.file);
            return {
              filename: att.file.name,
              content_type: att.file.type || 'application/octet-stream',
              data: dataUrl.replace(/^data:[^;]+;base64,/, ''),
            };
          }),
        );
        await api.cases.addComment(created.case_id, {
          parent_type: 'case',
          parent_id: created.case_id,
          body: 'Initial context files attached.',
          attachments: attachmentPayload,
        });
      }

      // Reset form
      attachments.forEach((a) => { if (a.preview) URL.revokeObjectURL(a.preview); });
      setTitle('');
      setDescription('');
      setSourceType('manual');
      setValidationTrack('direct');
      setRiskLevel('low');
      setPriority('normal');
      setJiraRefs('');
      setProjectId('');
      setRepositoryId('');
      setBranch('');
      setPrRef('');
      setAttachments([]);
      addToast('success', 'Case created');
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create case');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={dialogTitleId}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-lg mx-4 bg-surface-raised rounded-lg shadow-xl">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-border-subtle">
          <h3 id={dialogTitleId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">New Case</h3>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
            {error && (
              <div className="rounded-md bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
                {error}
              </div>
            )}

            {templates.length > 0 && (
              <Input
                as="select"
                label="Template (optional)"
                value={selectedTemplate}
                onChange={(e) => applyTemplate(e.target.value)}
              >
                <option value="">No template — start from scratch</option>
                {templates.map((t) => (
                  <option key={t.template_id} value={t.template_id}>
                    {t.name}{t.description ? ` — ${t.description}` : ''}
                  </option>
                ))}
              </Input>
            )}

            <Input
              label="Title *"
              type="text"
              placeholder="Brief case title..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />

            <Input
              as="textarea"
              label="Description"
              placeholder="Describe the case..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />

            <div className="grid grid-cols-2 gap-4">
              <Input
                as="select"
                label="Source Type"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value as SourceType)}
              >
                <option value="manual">Manual</option>
                <option value="jira">Jira</option>
                <option value="git">Git</option>
                <option value="other">Other</option>
              </Input>

              <Input
                as="select"
                label="Validation Track"
                value={validationTrack}
                onChange={(e) => setValidationTrack(e.target.value as ValidationTrack)}
              >
                <option value="direct">Direct</option>
                <option value="manual">Manual</option>
              </Input>

              <Input
                as="select"
                label="Risk Level"
                value={riskLevel}
                onChange={(e) => setRiskLevel(e.target.value as RiskLevel)}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </Input>

              <Input
                as="select"
                label="Priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </Input>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input
                as="select"
                label="Project *"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">Select project...</option>
                {projects.map((p) => (
                  <option key={p.project_id} value={p.project_id}>{p.name}</option>
                ))}
              </Input>
              <Input
                as="select"
                label="Repository *"
                value={repositoryId}
                onChange={(e) => setRepositoryId(e.target.value)}
                disabled={!projectId}
              >
                <option value="">{projectId ? 'Select repository...' : 'Select a project first'}</option>
                {repositories.map((r) => (
                  <option key={r.repository_id} value={r.repository_id}>{r.name}</option>
                ))}
              </Input>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Working Branch (optional)"
                hint="Can be added later — required before build"
                type="text"
                placeholder="e.g. feature/ARB-101-user-auth"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
              <Input
                label="Pull Request (optional)"
                type="text"
                placeholder="e.g. https://github.com/org/repo/pull/42"
                value={prRef}
                onChange={(e) => setPrRef(e.target.value)}
              />
            </div>

            {/* Attachments */}
            <div>
              <label className={labelClasses} htmlFor="case-attachment-input">
                Attachments <span className="text-gray-400 dark:text-gray-500 font-normal">(optional)</span>
              </label>
              <div
                className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-md px-4 py-3 text-center hover:border-accent transition-colors cursor-pointer"
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-accent', 'bg-accent-light'); }}
                onDragLeave={(e) => { e.currentTarget.classList.remove('border-accent', 'bg-accent-light'); }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('border-accent', 'bg-accent-light');
                  handleFileSelect(e.dataTransfer.files);
                }}
                onClick={() => document.getElementById('case-attachment-input')?.click()}
              >
                <input
                  id="case-attachment-input"
                  type="file"
                  className="hidden"
                  multiple
                  accept="image/*,.pdf,.log,.txt,.json,.csv"
                  onChange={(e) => handleFileSelect(e.target.files)}
                />
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Drop files here or <span className="text-accent-700 dark:text-accent-300 font-medium">browse</span>
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Screenshots, logs, docs — added as the first case comment</p>
              </div>
              {attachments.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {attachments.map((att, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm bg-surface-base dark:bg-surface-base/50 rounded px-2 py-1.5">
                      {att.preview ? (
                        <Image src={att.preview} alt="" className="h-8 w-8 object-cover rounded flex-shrink-0" width={32} height={32} unoptimized />
                      ) : (
                        <div className="h-8 w-8 bg-gray-200 dark:bg-gray-700 rounded flex items-center justify-center flex-shrink-0">
                          <span className="text-[10px] text-gray-500 dark:text-gray-400 uppercase">
                            {att.file.name.split('.').pop()}
                          </span>
                        </div>
                      )}
                      <span className="text-gray-700 dark:text-gray-300 truncate flex-1">{att.file.name}</span>
                      <span className="text-gray-400 dark:text-gray-500 text-xs flex-shrink-0">
                        {att.file.size < 1024
                          ? `${att.file.size} B`
                          : att.file.size < 1048576
                            ? `${(att.file.size / 1024).toFixed(1)} KB`
                            : `${(att.file.size / 1048576).toFixed(1)} MB`}
                      </span>
                      <button
                        type="button"
                        className="text-gray-400 dark:text-gray-500 hover:text-red-500 flex-shrink-0"
                        onClick={(e) => { e.stopPropagation(); removeAttachment(i); }}
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Input
              label="Jira References (optional)"
              hint="Comma-separated Jira ticket IDs"
              type="text"
              placeholder="ARB-101, ARB-102..."
              value={jiraRefs}
              onChange={(e) => setJiraRefs(e.target.value)}
            />
          </div>

          <div className="px-6 py-4 border-t border-gray-200 dark:border-border-subtle flex justify-end gap-3">
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              {submitting ? 'Creating...' : 'Create Case'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
