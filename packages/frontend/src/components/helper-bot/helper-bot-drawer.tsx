'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SideDrawer } from '../shared/side-drawer';
import { MarkdownContent } from '../shared/markdown-content';
import { HelperBotThinking } from './helper-bot-thinking';
import { api } from '../../lib/api-client';

interface HelperBotDrawerProps {
  open: boolean;
  onClose: () => void;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnswerMeta {
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
}

const STORAGE_KEY = 'arbitra_helper_chat';
// Match the server-side cap. Trimming client-side keeps sessionStorage
// bounded and matches what the backend will actually use.
const MAX_HISTORY_TURNS = 10;

/**
 * Strip a trailing unanswered `user` turn from a hydrated history.
 *
 * The drawer commits the user bubble + persists to sessionStorage BEFORE the
 * API call resolves so the bubble + thinking indicator render immediately.
 * If the call fails (or the tab closes mid-flight), the persisted history
 * ends with an orphan `user` turn that has no assistant reply. Restoring
 * that as-is would let the next submit send `[..., user(orphan), user(new)]`
 * — two consecutive user turns, which confuses Gemini. Drop the orphan on
 * hydrate so the conversation resumes from the last completed exchange.
 *
 * Exported for unit testing (the hydrate path runs in a useEffect and the
 * drawer's vitest setup is node-only — no jsdom — so we can't observe it
 * via render output).
 */
export function dropOrphanTrailingUser(
  messages: ChatMessage[],
): ChatMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') return messages.slice(0, -1);
  return messages;
}

/**
 * Drawer surface for the Arbitra Helper Bot — multi-turn chat.
 *
 * Layout:
 *   - Top (scrollable): chat bubbles. User right-aligned, assistant left.
 *   - Bottom (fixed): textarea + send button. Cmd/Ctrl+Enter submits.
 *
 * Persistence: messages live in `sessionStorage` under
 * `arbitra_helper_chat`. They survive page refresh within the tab session
 * but are dropped when the tab closes. "Clear conversation" wipes both
 * in-memory state and the storage key. Firestore persistence is deliberately
 * out of scope for this iteration.
 *
 * Loading state: the user's just-sent turn renders immediately as a bubble
 * with the shared `<HelperBotThinking />` indicator underneath while the
 * reply is in flight.
 *
 * Error state: rendered as an inline system bubble; the input remains
 * usable so the user can retry.
 */
export function HelperBotDrawer({ open, onClose }: HelperBotDrawerProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastMeta, setLastMeta] = useState<AnswerMeta | null>(null);

  // Track latest in-flight request so a stale response (drawer reopen
  // mid-flight, or rapid resubmit) can't overwrite fresh state.
  const requestIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Hydrate from sessionStorage on first open. Read each time the drawer
  // opens so a "Clear conversation" in another tab session would pick up.
  useEffect(() => {
    if (!open) return;
    if (typeof window === 'undefined') return;
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const safe = parsed.filter(
          (m): m is ChatMessage =>
            !!m &&
            typeof m === 'object' &&
            (m as ChatMessage).role !== undefined &&
            ((m as ChatMessage).role === 'user' ||
              (m as ChatMessage).role === 'assistant') &&
            typeof (m as ChatMessage).content === 'string',
        );
        setMessages(dropOrphanTrailingUser(safe));
      }
    } catch {
      // Corrupt payload — ignore and start clean.
    }
  }, [open]);

  // Persist on every change.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (messages.length === 0) {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } else {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
      }
    } catch {
      // Quota / disabled storage — silently degrade. The chat keeps working
      // in-memory; we just lose refresh persistence.
    }
  }, [messages]);

  // Auto-scroll on new messages or while a reply is loading.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const submit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const userTurn: ChatMessage = { role: 'user', content: trimmed };
    // Snapshot of history sent to the API: everything BEFORE the new user
    // turn (the new turn is sent as `question`). Cap to most recent N.
    const historyForApi = messages.slice(-MAX_HISTORY_TURNS);

    setMessages((prev) => [...prev, userTurn]);
    setInput('');
    setErrorMsg(null);
    setLoading(true);

    const id = ++requestIdRef.current;
    try {
      const result = await api.helper.ask(trimmed, historyForApi);
      if (requestIdRef.current !== id) return;
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: result.answer },
      ]);
      setLastMeta({
        latency_ms: result.latency_ms,
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
      });
    } catch (err) {
      if (requestIdRef.current !== id) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestIdRef.current === id) setLoading(false);
    }
  }, [input, loading, messages]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const clearConversation = useCallback(() => {
    setMessages([]);
    setErrorMsg(null);
    setLastMeta(null);
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }, []);

  const canSubmit = input.trim().length > 0 && !loading;
  const hasMessages = messages.length > 0;

  return (
    <SideDrawer open={open} onClose={onClose} title="Arbitra Helper" width="lg">
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Ask about Arbitra setup, MCP/IDE integration, concepts, rules. For
            case-specific or codebase questions, ask your IDE agent (Claude
            Code / Cursor / Codex) instead — they have your working tree.
          </p>
          {hasMessages && (
            <button
              type="button"
              onClick={clearConversation}
              className="shrink-0 rounded-md border border-gray-300 bg-surface-raised px-2 py-1 text-xs font-medium text-gray-700 shadow-sm hover:bg-surface-base focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 dark:border-border-subtle dark:text-gray-200 dark:hover:bg-border-subtle/40 dark:focus:ring-offset-surface-base"
              data-testid="helper-bot-clear"
            >
              Clear conversation
            </button>
          )}
        </div>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto rounded-md border border-gray-200 bg-surface-base p-3 dark:border-border-subtle dark:bg-surface-raised"
          data-testid="helper-bot-messages"
        >
          {!hasMessages && !loading && (
            <p className="text-sm text-gray-500 dark:text-gray-500">
              No messages yet. Ask anything below to get started.
            </p>
          )}
          <ul className="flex flex-col gap-3">
            {messages.map((m, i) => (
              <li
                key={i}
                className={
                  m.role === 'user'
                    ? 'flex justify-end'
                    : 'flex justify-start'
                }
                data-testid={
                  m.role === 'user'
                    ? 'helper-bot-msg-user'
                    : 'helper-bot-msg-assistant'
                }
              >
                <div
                  className={
                    m.role === 'user'
                      ? 'max-w-[85%] rounded-lg bg-accent-700 px-3 py-2 text-sm text-white shadow-sm'
                      : 'max-w-[85%] rounded-lg border border-gray-200 bg-surface-raised px-3 py-2 text-sm text-gray-900 shadow-sm dark:border-border-subtle dark:bg-surface-base dark:text-gray-100'
                  }
                >
                  {m.role === 'assistant' ? (
                    <MarkdownContent>{m.content}</MarkdownContent>
                  ) : (
                    <span className="whitespace-pre-wrap">{m.content}</span>
                  )}
                </div>
              </li>
            ))}
            {loading && (
              <li className="flex justify-start">
                <div className="max-w-[85%]">
                  <HelperBotThinking />
                </div>
              </li>
            )}
            {errorMsg && (
              <li className="flex justify-start" data-testid="helper-bot-error">
                <div className="max-w-[85%] rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
                  {errorMsg}
                </div>
              </li>
            )}
          </ul>
        </div>

        {lastMeta && !loading && !errorMsg && (
          <div className="text-right text-xs text-gray-500 dark:text-gray-500">
            {lastMeta.latency_ms} ms · {lastMeta.prompt_tokens} prompt /{' '}
            {lastMeta.completion_tokens} completion tokens
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={loading}
            rows={3}
            placeholder="e.g. How do I wire up the MCP server in Cursor?"
            className="w-full resize-y rounded-md border border-gray-300 bg-surface-base px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-border-subtle dark:bg-surface-raised dark:text-gray-100"
            data-testid="helper-bot-input"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-500 dark:text-gray-500">
              Tip: press Cmd/Ctrl+Enter to submit.
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="inline-flex items-center justify-center rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-800 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus:ring-offset-surface-base"
              data-testid="helper-bot-submit"
            >
              {loading ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </SideDrawer>
  );
}
