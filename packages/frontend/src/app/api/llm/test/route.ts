import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError, requireProjectAccess } from '@/lib/api-helpers';
import type { LlmProviderName, RiskLevel } from '@arbitra/shared';
import { LLM_PROVIDERS } from '@arbitra/shared';
import { checkRateLimit } from './rate-limit';

// Providers the ping endpoint may call — the catalog's enabled flag is the
// single switch, so enabling a provider there also enables its test button.
const ENABLED_PING_PROVIDERS = new Set<string>(
  LLM_PROVIDERS.filter((p) => p.enabled).map((p) => p.id),
);

// ---------------------------------------------------------------------------
// Per-call ping
// ---------------------------------------------------------------------------

const PER_CALL_TIMEOUT_MS = 30_000; // reasoning models need longer than a plain completion
const TOTAL_TIMEOUT_MS = 35_000; // above PER_CALL_TIMEOUT_MS so the per-call error wins

type PingResult = {
  ok: boolean;
  latency_ms: number;
  error?: string;
  model: string;
  skipped?: boolean;
  reason?: string;
};

function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Strip api keys (common patterns) and stack traces; cap length.
  const withoutKeys = raw
    .replace(/([Aa][Pp][Ii][-_ ]?[Kk][Ee][Yy][^\s,]*)/g, '[redacted]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .split('\n')[0] ?? '';
  return withoutKeys.slice(0, 240).trim();
}

async function pingModel(
  provider: LlmProviderName,
  model: string,
): Promise<PingResult> {
  const start = Date.now();
  try {
    const { resolveModel } = await import('@arbitra/backend');
    const { generateText } = await import('ai');
    const languageModel = await resolveModel(provider, model);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
    try {
      await generateText({
        model: languageModel,
        prompt: 'ok',
        maxOutputTokens: 16, // OpenAI rejects values below 16
        abortSignal: controller.signal,
      });
      return {
        ok: true,
        latency_ms: Date.now() - start,
        model,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const message = sanitizeError(err);
    const isAbort = /abort/i.test(message);
    return {
      ok: false,
      latency_ms: Date.now() - start,
      error: isAbort ? `Timed out after ${PER_CALL_TIMEOUT_MS}ms` : message,
      model,
    };
  }
}

// ---------------------------------------------------------------------------
// Request schema validation
// ---------------------------------------------------------------------------

const RISK_KEYS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
const VALID_PROVIDERS: LlmProviderName[] = ['anthropic', 'openai', 'google', 'openrouter'];

type TestRequestBody = {
  provider: LlmProviderName;
  models: Partial<Record<RiskLevel, string>>;
  project_id?: string;
};

function parseBody(raw: unknown): { ok: true; value: TestRequestBody } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, message: 'Body must be an object' };
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.provider !== 'string' || !VALID_PROVIDERS.includes(body.provider as LlmProviderName)) {
    return { ok: false, message: 'Invalid provider' };
  }
  if (!body.models || typeof body.models !== 'object') {
    return { ok: false, message: 'Missing models' };
  }
  const rawModels = body.models as Record<string, unknown>;
  const models: Partial<Record<RiskLevel, string>> = {};
  for (const key of RISK_KEYS) {
    const v = rawModels[key];
    if (v !== undefined && v !== null && v !== '') {
      if (typeof v !== 'string') {
        return { ok: false, message: `models.${key} must be a string` };
      }
      models[key] = v;
    }
  }
  const project_id = typeof body.project_id === 'string' && body.project_id ? body.project_id : undefined;
  return { ok: true, value: { provider: body.provider as LlmProviderName, models, project_id } };
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    const rawBody = await request.json();
    const parsed = parseBody(rawBody);
    if (!parsed.ok) {
      return NextResponse.json({ error: { message: parsed.message } }, { status: 400 });
    }
    const { provider, models, project_id } = parsed.value;

    // Auth gate
    if (project_id) {
      const denied = await requireProjectAccess(project_id, auth.userId);
      if (denied) return denied;
    } else {
      const { requireRole } = await import('@arbitra/backend');
      await requireRole(auth.userId, ['admin']);
    }

    // Rate limit
    if (!checkRateLimit(auth.userId)) {
      return NextResponse.json(
        { error: { message: 'Rate limit exceeded. Max 5 test calls per minute.' } },
        { status: 429 },
      );
    }

    // Launch pings in parallel per populated risk.
    const entries: Array<[RiskLevel, string]> = [];
    for (const key of RISK_KEYS) {
      const model = models[key];
      if (model) entries.push([key, model]);
    }

    const results: Partial<Record<RiskLevel, PingResult>> = {};

    const runAll = async () => {
      const settled = await Promise.allSettled(
        entries.map(async ([risk, model]) => {
          if (!ENABLED_PING_PROVIDERS.has(provider)) {
            results[risk] = {
              ok: false,
              latency_ms: 0,
              model,
              skipped: true,
              reason: 'provider not enabled',
            };
            return;
          }
          results[risk] = await pingModel(provider, model);
        }),
      );
      // Any rejections get an error slot
      settled.forEach((s, idx) => {
        if (s.status === 'rejected') {
          const entry = entries[idx];
          if (!entry) return;
          const [risk, model] = entry;
          results[risk] = {
            ok: false,
            latency_ms: 0,
            model,
            error: sanitizeError(s.reason),
          };
        }
      });
    };

    const totalTimeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), TOTAL_TIMEOUT_MS),
    );

    const outcome = await Promise.race([runAll().then(() => 'done' as const), totalTimeout]);

    if (outcome === 'timeout') {
      // Fill missing risks with timeout status.
      for (const [risk, model] of entries) {
        if (!results[risk]) {
          results[risk] = {
            ok: false,
            latency_ms: TOTAL_TIMEOUT_MS,
            model,
            error: `Timed out after ${TOTAL_TIMEOUT_MS}ms`,
          };
        }
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    return handleError(error);
  }
}
