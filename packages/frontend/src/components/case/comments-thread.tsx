'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import Image from 'next/image';
import useSWR from 'swr';
import { MarkdownContent } from '../shared/markdown-content';
import type { Artifact, CommentParentType, Comment } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';
import { useUserMap } from '../../hooks/use-users';
import { useAuth } from '../../providers/auth-provider';
import { UserDisplay } from '../shared/user-display';
import { ActorSignature } from '../shared/actor-signature';
import { SkeletonText } from '../shared/skeleton';
import ErrorCard from '../shared/error-card';
import { RelativeTime } from '../shared/relative-time';
import { Button } from '../ui/button';

function CommentTimestamp({ createdAt }: { createdAt: string }) {
  return (
    <RelativeTime
      timestamp={createdAt}
      className="text-xs text-gray-500 dark:text-gray-400"
    />
  );
}

function getAgentDisplayName(agentName: string | undefined): string {
  if (!agentName) return 'IDE Agent';
  if (agentName === 'claude-code') return 'Claude Code';
  if (agentName === 'cursor') return 'Cursor';
  if (agentName === 'copilot') return 'Copilot';
  return agentName;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function AttachmentFileBadge({ filename }: { filename: string }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-gray-100 text-[10px] font-semibold uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
      {filename.split('.').pop()}
    </span>
  );
}

function AttachmentDetails({ attachment }: { attachment: Artifact }) {
  return (
    <span className="min-w-0">
      <span className="block max-w-48 truncate font-medium" title={attachment.filename}>
        {attachment.filename}
      </span>
      <span className="block text-[10px] text-gray-400 dark:text-gray-500">
        {formatSize(attachment.size_bytes)}
      </span>
    </span>
  );
}

/**
 * SWR key for an attachment's content fetch. Includes the signed-in user's
 * uid so a cached artifact response can never be served across accounts:
 * `AuthProvider.signOut` doesn't clear SWR's global cache or reload the app,
 * so without this a same-tab sign-out + different sign-in could otherwise
 * reuse user A's cached attachment bytes for user B. Gated on `shouldLoad`
 * first so nothing fetches eagerly, and on `uid` so it can never fire before
 * auth is ready. Exported so the identity-scoping can be tested directly
 * without needing to flip real component state.
 */
export function artifactContentSwrKey(
  shouldLoad: boolean,
  artifactId: string,
  uid: string | undefined,
): [string, string, string] | null {
  return shouldLoad && uid ? ['artifact-content', artifactId, uid] : null;
}

function CommentAttachment({ attachment }: { attachment: Artifact }) {
  const [shouldLoad, setShouldLoad] = useState(false);
  const isImage = attachment.content_type.startsWith('image/');
  const { user } = useAuth();
  const uid = user?.uid;
  const { data: contentUrl, error, isLoading, isValidating, mutate } = useSWR(
    artifactContentSwrKey(shouldLoad, attachment.artifact_id, uid),
    () => api.artifacts.content(attachment.artifact_id),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
  );

  if (error) {
    return (
      <div className="max-w-full rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-gray-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-gray-300">
        <div className="flex items-center gap-2">
          <AttachmentFileBadge filename={attachment.filename} />
          <AttachmentDetails attachment={attachment} />
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[10px] text-red-600 dark:text-red-400">
            {error instanceof Error ? error.message : 'Failed to load attachment'}
          </span>
          <Button variant="link" size="xs" onClick={() => void mutate()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!contentUrl) {
    return (
      <Button
        variant="secondary"
        size="xs"
        loading={shouldLoad && (isLoading || isValidating)}
        onClick={() => setShouldLoad(true)}
        className="max-w-full"
        aria-label={`Load ${attachment.filename}`}
      >
        <AttachmentFileBadge filename={attachment.filename} />
        <AttachmentDetails attachment={attachment} />
      </Button>
    );
  }

  return (
    <a
      href={contentUrl}
      download={attachment.filename}
      className="inline-flex max-w-full items-center gap-2 rounded-md border border-gray-200 dark:border-border-subtle bg-surface-base px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent-700 dark:hover:text-accent-300"
    >
      {isImage ? (
        <Image
          src={contentUrl}
          alt=""
          className="h-8 w-8 rounded object-cover"
          width={32}
          height={32}
          unoptimized
        />
      ) : (
        <AttachmentFileBadge filename={attachment.filename} />
      )}
      <AttachmentDetails attachment={attachment} />
    </a>
  );
}

function CommentAttachments({ attachments }: { attachments?: Artifact[] }) {
  if (!attachments?.length) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <CommentAttachment key={attachment.artifact_id} attachment={attachment} />
      ))}
    </div>
  );
}

interface PendingAttachment {
  file: File;
  preview: string;
}

function AgentBadge({ comment, authorDisplayName }: { comment: Comment; authorDisplayName: string }) {
  if (comment.source !== 'ide_agent') return null;
  // Legacy fallback only: when actor_metadata is present, ActorSignature
  // already renders a more precise identity chip (client_name from MCP
  // handshake) — the generic "IDE Agent" badge is redundant and confusing
  // ("ide-agent" next to "Cursor Vscode" looks like two separate actors).
  if (comment.actor_metadata?.client_name) return null;
  const agentDisplay = getAgentDisplayName(comment.agent_name);
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-border-subtle leading-none"
      title={`Posted by ${agentDisplay} on behalf of ${authorDisplayName}`}
    >
      <svg className="h-2.5 w-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73A2 2 0 0 1 10 4a2 2 0 0 1 2-2" />
        <circle cx="9" cy="14" r="1" fill="currentColor" stroke="none" />
        <circle cx="15" cy="14" r="1" fill="currentColor" stroke="none" />
        <path d="M9 18h6" />
      </svg>
      {agentDisplay}
    </span>
  );
}

interface CommentsThreadProps {
  caseId: string;
  parentType: CommentParentType;
  parentId: string;
}

export function CommentsThread({ caseId, parentType, parentId }: CommentsThreadProps) {
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const attachmentsRef = useRef(attachments);
  const { addToast } = useToast();

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((attachment) => {
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      });
    };
  }, []);

  const fetcher = () => {
    if (parentType === 'case') {
      return api.cases.comments(caseId);
    }
    return api.findings.comments(parentId);
  };

  const { data, error, isLoading, mutate } = useSWR(
    ['comments', parentType, parentId],
    fetcher,
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() && attachments.length === 0) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const attachmentPayload = await Promise.all(
        attachments.map(async (attachment) => ({
          filename: attachment.file.name,
          content_type: attachment.file.type || 'application/octet-stream',
          data: await fileToBase64(attachment.file),
        })),
      );
      const payload = {
        parent_type: parentType,
        parent_id: parentId,
        body: body.trim() || 'Attached files.',
        ...(attachmentPayload.length > 0 && { attachments: attachmentPayload }),
      };
      if (parentType === 'case') {
        await api.cases.addComment(caseId, payload);
      } else {
        await api.findings.addComment(parentId, payload);
      }
      attachments.forEach((attachment) => {
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      });
      setAttachments([]);
      setBody('');
      addToast('success', 'Comment added');
      mutate();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to add comment');
    } finally {
      setSubmitting(false);
    }
  }

  const comments = data?.comments ?? [];

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        resolve(dataUrl.replace(/^data:[^;]+;base64,/, ''));
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function handleFileSelect(files: FileList | null) {
    if (!files) return;
    const selected = Array.from(files).map((file) => ({
      file,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
    }));
    setAttachments((prev) => {
      const combined = [...prev, ...selected];
      const kept = combined.slice(0, 20);
      combined.slice(20).forEach((attachment) => {
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      });
      return kept;
    });
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => {
      const removed = prev[index];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  const authorIds = useMemo(
    () => [...new Set((data?.comments ?? []).map((c) => c.author_id))],
    [data?.comments],
  );
  const users = useUserMap(authorIds);

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg">
      <div className="border-b border-gray-200 dark:border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Comments ({comments.length})
          </h3>
          <span
            className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 text-[10px] font-bold cursor-help"
            title="Comments enable the dialogue between developers and reviewers. Use them to discuss findings, provide context, argue for or against a decision, or coordinate next steps. Comments on specific findings are available in the Courtroom view."
          >
            ?
          </span>
        </div>
      </div>

      {isLoading ? (
        <div className="px-4 py-4 space-y-4">
          <SkeletonText lines={2} />
          <SkeletonText lines={3} />
          <SkeletonText lines={2} />
        </div>
      ) : error ? (
        <div className="px-4 py-4">
          <ErrorCard
            title="Failed to load comments"
            message={error instanceof Error ? error.message : String(error)}
            onRetry={() => mutate()}
          />
        </div>
      ) : comments.length === 0 ? (
        <div className="px-6 py-8 text-center">
          <svg className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
          </svg>
          <p className="mt-2 text-sm font-medium text-gray-700 dark:text-gray-300">Start the conversation</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
            Use comments to discuss the case with your team. Ask questions, provide context,
            or coordinate next steps. Everyone involved in the case will see this thread.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {comments.map((comment) => {
            const authorDisplayName = users[comment.author_id]?.display_name ?? comment.author_id;
            return (
            <li key={comment.comment_id} data-entity-id={comment.comment_id} className="px-4 py-3 rounded transition-colors">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                  <UserDisplay userId={comment.author_id} users={users} showAvatar />
                  <AgentBadge comment={comment} authorDisplayName={authorDisplayName} />
                  <ActorSignature meta={comment.actor_metadata} />
                </span>
                <CommentTimestamp createdAt={comment.created_at} />
              </div>
              <MarkdownContent className="mt-1 text-sm leading-relaxed text-gray-700 dark:text-gray-300">{comment.body}</MarkdownContent>
              <CommentAttachments attachments={comment.attachments} />
            </li>
          );
          })}
        </ul>
      )}

      <div className="border-t border-gray-200 dark:border-border-subtle px-4 py-3">
        <form onSubmit={handleSubmit}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a comment..."
            rows={3}
            className="w-full rounded-md border border-gray-300 dark:border-border-default px-3 py-2 text-sm text-gray-900 dark:text-gray-200 bg-input-bg placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-y"
          />
          {attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {attachments.map((attachment, index) => (
                <div
                  key={`${attachment.file.name}-${index}`}
                  className="inline-flex max-w-full items-center gap-2 rounded-md border border-gray-200 dark:border-border-subtle bg-surface-base px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300"
                >
                  {attachment.preview ? (
                    <Image
                      src={attachment.preview}
                      alt=""
                      className="h-8 w-8 rounded object-cover"
                      width={32}
                      height={32}
                      unoptimized
                    />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-gray-100 text-[10px] font-semibold uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                      {attachment.file.name.split('.').pop()}
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block max-w-48 truncate font-medium" title={attachment.file.name}>
                      {attachment.file.name}
                    </span>
                    <span className="block text-[10px] text-gray-400 dark:text-gray-500">
                      {formatSize(attachment.file.size)}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(index)}
                    className="text-gray-400 hover:text-red-600 dark:text-gray-500 dark:hover:text-red-400"
                    aria-label={`Remove ${attachment.file.name}`}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          {submitError && (
            <p className="mt-1 text-xs text-red-600">{submitError}</p>
          )}
          <div className="mt-2 flex items-center justify-between gap-3">
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-accent-700 dark:text-gray-400 dark:hover:text-accent-300">
              <input
                type="file"
                className="hidden"
                multiple
                accept="image/*,.pdf,.log,.txt,.json,.csv"
                onChange={(e) => {
                  handleFileSelect(e.target.files);
                  e.currentTarget.value = '';
                }}
              />
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94a3 3 0 1 1 4.243 4.243L8.552 18.32a1.5 1.5 0 1 1-2.121-2.121l9.192-9.192" />
              </svg>
              Attach files
            </label>
            <button
              type="submit"
              disabled={submitting || (!body.trim() && attachments.length === 0)}
              className="inline-flex items-center rounded-md bg-accent-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Posting...' : 'Post Comment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
