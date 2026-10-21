import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import { applyUserRateLimit } from '../../auth/connect/_helpers';

export const dynamic = 'force-dynamic';

const MAX_QUESTION_LENGTH = 2000;
const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_CONTENT_LENGTH = 4000;
// Each call sends the docs corpus as a large prompt; cap per-user spend.
const HELPER_RATE_LIMIT = { bucket: 'helper', maxRequests: 30, windowMs: 60 * 60 * 1000 };

interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * POST /api/helper/ask
 *
 * Multi-turn Q&A against the Arbitra Helper bot. Body:
 *   `{ question: string, history?: Array<{ role, content }> }`.
 * `history` is optional — if absent, behaves as a single-turn call
 * (back-compat with the original single-turn contract). Server caps history at
 * 10 turns, truncating to the most recent. Auth: any logged-in user.
 * Returns `{ answer, latency_ms, prompt_tokens, completion_tokens }`.
 * See `HelperBotService` for the full contract.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    if (!(await applyUserRateLimit(auth.userId, HELPER_RATE_LIMIT))) {
      return NextResponse.json(
        { error: { message: 'Helper rate limit reached (30 questions per hour). Try again later.' } },
        { status: 429 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { message: 'Request body must be valid JSON' } },
        { status: 400 },
      );
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: { message: 'Request body must be a JSON object' } },
        { status: 400 },
      );
    }

    const { question, history } = body as Record<string, unknown>;
    if (typeof question !== 'string' || question.trim() === '') {
      return NextResponse.json(
        { error: { message: 'question is required and must be a non-empty string' } },
        { status: 400 },
      );
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return NextResponse.json(
        {
          error: {
            message: `question must be ${MAX_QUESTION_LENGTH} characters or fewer`,
          },
        },
        { status: 400 },
      );
    }

    let historyTurns: HistoryTurn[] = [];
    if (history !== undefined) {
      if (!Array.isArray(history)) {
        return NextResponse.json(
          { error: { message: 'history must be an array if provided' } },
          { status: 400 },
        );
      }
      for (const item of history) {
        if (!item || typeof item !== 'object') {
          return NextResponse.json(
            {
              error: {
                message: 'history items must be objects with role + content',
              },
            },
            { status: 400 },
          );
        }
        const { role, content } = item as Record<string, unknown>;
        if (role !== 'user' && role !== 'assistant') {
          return NextResponse.json(
            {
              error: {
                message: "history role must be 'user' or 'assistant'",
              },
            },
            { status: 400 },
          );
        }
        if (typeof content !== 'string' || content.trim() === '') {
          return NextResponse.json(
            {
              error: {
                message: 'history content must be a non-empty string',
              },
            },
            { status: 400 },
          );
        }
        if (content.length > MAX_HISTORY_CONTENT_LENGTH) {
          return NextResponse.json(
            {
              error: {
                message: `history content must be ${MAX_HISTORY_CONTENT_LENGTH} characters or fewer`,
              },
            },
            { status: 400 },
          );
        }
        historyTurns.push({ role, content });
      }
      // Cap to most recent N turns. Service also caps; doing it here keeps
      // the network payload visible in logs honest about what was used.
      if (historyTurns.length > MAX_HISTORY_TURNS) {
        historyTurns = historyTurns.slice(-MAX_HISTORY_TURNS);
      }
    }

    const { HelperBotService } = await import('@arbitra/backend');
    const service = new HelperBotService();
    const result = await service.ask(question, auth.userId, historyTurns);
    return NextResponse.json(result);
  } catch (error) {
    return handleError(error);
  }
}
