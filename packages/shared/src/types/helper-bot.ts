/**
 * One log entry per Arbitra Helper bot invocation.
 *
 * The bot answers onboarding/setup questions about the Arbitra platform itself
 * (concepts, MCP/IDE setup, lifecycle, rules, configuration). It is NOT a
 * case-aware agent — those questions are redirected to the user's IDE agent.
 *
 * Logged to the `helper_bot_logs` Firestore collection (one doc per call) for
 * observability + abuse review. The full answer is not stored — only a
 * preview — to keep the collection cheap to scan.
 */
export interface HelperBotLog {
  log_id: string;
  user_id: string;
  question: string;
  answer_preview: string;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: string;
  /**
   * Zero-based index of this turn within the conversation. `0` means the
   * first user turn (no prior history). One log row is written per turn —
   * the full conversation is never persisted.
   */
  turn_index?: number;
}

/**
 * One conversational turn passed to the Helper bot. The `assistant` role
 * is for prior bot replies; `user` is for prior user questions. The current
 * turn's question is sent separately as the `question` field.
 */
export interface HelperBotHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}
