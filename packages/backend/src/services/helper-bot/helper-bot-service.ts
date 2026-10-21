/**
 * Arbitra Helper bot service.
 *
 * Multi-turn, non-streaming Q&A over the platform docs + knowledge assets.
 * NOT a case-aware agent — case/code questions get redirected to the IDE
 * agent (see prompt-assembler.ts).
 *
 * Each call:
 *  1. Assembles the constant system prompt (docs + knowledge).
 *  2. Resolves a model via the shared `resolveModelForRisk('low')` helper —
 *     the same Firestore-settings > env-var > hardcoded-default chain (and
 *     `enabled`-flag enforcement) as case review, treating the Q&A bot as a
 *     'low'-risk, cheap/fast workload. NOT a hardcoded provider literal
 *     (was `resolveModel('google', 'gemini-3.5-flash')` — #1099, a stored
 *     `enabled: false` for google was silently ignored here), passing the
 *     prior turns as `messages` so the model has conversational context.
 *  3. Logs the call to `helper_bot_logs` (one doc per *turn*) for
 *     observability and abuse review. Log writes are best-effort —
 *     a logging failure never breaks the user-facing response. Only the
 *     latest user turn is persisted on the log row (PII discipline);
 *     `turn_index` records the position of the turn in the conversation.
 *  4. Returns answer + latency + token usage.
 */
import { generateText } from 'ai';
import { collections } from '../../lib/firestore.js';
import { generateId } from '../../lib/ids.js';
import { resolveModelForRisk } from '../../lib/llm-provider.js';
import type { HelperBotHistoryTurn, HelperBotLog } from '@arbitra/shared';
import { assembleSystemPrompt } from './prompt-assembler.js';

export interface HelperBotAnswer {
  answer: string;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * Server-side cap on conversation history. Caller may pass more, but we
 * truncate to the most recent N turns to keep prompt size and per-call
 * cost bounded. Turns older than the cap are silently dropped.
 */
export const MAX_HISTORY_TURNS = 10;

export class HelperBotService {
  async ask(
    question: string,
    userId: string,
    history: HelperBotHistoryTurn[] = [],
  ): Promise<HelperBotAnswer> {
    const system = await assembleSystemPrompt();
    const model = await resolveModelForRisk('low');

    // Cap defensively — the route validates too, but the service is the
    // last line of defence against an unbounded prompt.
    const trimmedHistory =
      history.length > MAX_HISTORY_TURNS
        ? history.slice(-MAX_HISTORY_TURNS)
        : history;

    const startedAt = Date.now();
    const result = await generateText({
      model,
      system,
      messages: [
        ...trimmedHistory.map((t) => ({ role: t.role, content: t.content })),
        { role: 'user' as const, content: question },
      ],
    });
    const latency_ms = Date.now() - startedAt;

    const answer = result.text ?? '';
    // AI SDK v6 reports usage as inputTokens / outputTokens.
    const usage = (result.usage ?? {}) as { inputTokens?: number; outputTokens?: number };
    const prompt_tokens = usage.inputTokens ?? 0;
    const completion_tokens = usage.outputTokens ?? 0;

    // turn_index counts user turns: 0 = first question of the conversation.
    // History contains alternating user/assistant turns; counting user
    // entries in history gives the index of the *current* user turn.
    const turn_index = trimmedHistory.filter((t) => t.role === 'user').length;

    await this.writeLog({
      userId,
      question,
      answer,
      latency_ms,
      prompt_tokens,
      completion_tokens,
      turn_index,
    });

    return { answer, latency_ms, prompt_tokens, completion_tokens };
  }

  private async writeLog(input: {
    userId: string;
    question: string;
    answer: string;
    latency_ms: number;
    prompt_tokens: number;
    completion_tokens: number;
    turn_index: number;
  }): Promise<void> {
    const log: HelperBotLog = {
      log_id: generateId('helperBotLog'),
      user_id: input.userId,
      question: input.question,
      answer_preview: input.answer.slice(0, 500),
      latency_ms: input.latency_ms,
      prompt_tokens: input.prompt_tokens,
      completion_tokens: input.completion_tokens,
      created_at: new Date().toISOString(),
      turn_index: input.turn_index,
    };
    try {
      await collections.helperBotLogs().doc(log.log_id).set(log);
    } catch (err) {
      // Best-effort logging — never fail the user-facing call on a log write.
      // Include identifying fields: until rate limiting lands, this warn
      // line is the only abuse-detection signal we have.
      console.warn('[HelperBotService] failed to persist log:', {
        log_id: log.log_id,
        user_id: log.user_id,
        question_length: input.question.length,
        error: err,
      });
    }
  }
}
