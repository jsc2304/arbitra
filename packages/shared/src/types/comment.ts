import type { ActorMetadata } from './actor-metadata.js';
import type { Artifact, InlineAttachment } from './artifact.js';

export type CommentParentType = 'finding' | 'case';

export type CommentSource = 'human' | 'ide_agent' | 'google_chat';

/**
 * Structural tag that identifies special-purpose comments emitted by the
 * lifecycle pipeline (exploration / build summaries). Absent on regular
 * discussion comments. Untagged values are valid — comments created before
 * the tag was introduced have no `kind`, and the dossier falls back to
 * temporal pairing for those.
 */
export type CommentKind = 'exploration_summary' | 'build_summary';

export interface Comment {
  comment_id: string;
  parent_type: CommentParentType;
  parent_id: string;
  author_id: string;
  body: string;
  created_at: string;
  source?: CommentSource;   // absent = treat as 'human'
  agent_name?: string;      // e.g. 'claude-code', 'cursor', 'copilot'
  /**
   * Authoritative client/model signature when the comment is posted by an
   * IDE agent. Populated by the MCP client on the API call — separate from
   * any self-report inside `body`. All fields optional.
   */
  actor_metadata?: ActorMetadata;
  /**
   * Artifact IDs attached to this comment. Artifact documents remain the
   * storage metadata source of truth; this field keeps the comment thread as
   * the user-facing workflow for unstructured files.
   */
  attachment_refs?: string[];
  /**
   * Read-model convenience populated by comment list endpoints. Not required
   * on stored comment documents.
   */
  attachments?: Artifact[];
  /**
   * Optional structural tag for lifecycle-emitted summary comments. Set
   * server-side by `/api/agent/explore` and `/api/agent/build-complete` so
   * the dossier can identify the summary slots without temporal pairing.
   * Never set by the regular comment routes.
   */
  kind?: CommentKind;
}

export interface CreateCommentInput {
  parent_type: CommentParentType;
  parent_id: string;
  body: string;
  source?: CommentSource;
  agent_name?: string;
  actor_metadata?: ActorMetadata;
  attachments?: InlineAttachment[];
}
