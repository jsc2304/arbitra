import { z } from 'zod';
import { prRefSchema } from './pr-ref-schema.js';

/** Max inline attachment size: 10 MB base64-encoded */
const MAX_INLINE_SIZE = 10 * 1024 * 1024 * 1.37; // ~13.7 MB base64 for 10 MB binary

export const inlineAttachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(127),
  data: z.string().min(1).max(MAX_INLINE_SIZE),
});

export const gitContextSchema = z.object({
  branch: z.string().max(255).optional(),
  remote_url: z.string().max(1000).optional(),
  commit_sha: z.string().max(40).optional(),
  /**
   * Validated as a real PR reference (issue #1046). `POST /api/cases`
   * applies `git_context` AFTER `createCaseSchema` runs and writes
   * `pr_ref` straight to `Case.current_pr_ref` through `caseRepo`, so an
   * unvalidated value here bypassed the `current_pr_ref` validation on the
   * schema itself — and `current_pr_ref` is what the terminal-case ownership
   * check compares against. An empty string is still accepted and means "no
   * PR": clients auto-detecting git context send one when the branch has no
   * PR yet.
   */
  pr_ref: z.union([z.literal(''), prRefSchema]).optional(),
  repo_root: z.string().max(1000).optional(),
});

export const createArtifactSchema = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(127),
  data: z.string().min(1).describe('Base64-encoded file content'),
});

export type InlineAttachmentPayload = z.infer<typeof inlineAttachmentSchema>;
export type GitContextPayload = z.infer<typeof gitContextSchema>;
export type CreateArtifactPayload = z.infer<typeof createArtifactSchema>;
