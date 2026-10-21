import { describe, it, expect, vi, beforeEach } from 'vitest';

const writes: Array<{ id: string; data: unknown }> = [];

vi.mock('../../../lib/firestore.js', () => ({
  collections: {
    helperBotLogs: () => ({
      doc: (id: string) => ({
        set: async (data: unknown) => {
          writes.push({ id, data });
        },
      }),
    }),
    knowledgeAssets: () => ({
      get: async () => ({ docs: [] }),
    }),
  },
}));

const resolveModelForRiskMock = vi.fn();
vi.mock('../../../lib/llm-provider.js', () => ({
  resolveModelForRisk: (...args: unknown[]) => resolveModelForRiskMock(...args),
}));

const generateTextMock = vi.fn();
vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock('../prompt-assembler.js', () => ({
  assembleSystemPrompt: vi.fn(async () => 'SYSTEM_PROMPT'),
}));

import { HelperBotService, MAX_HISTORY_TURNS } from '../helper-bot-service.js';
import { assembleSystemPrompt } from '../prompt-assembler.js';

beforeEach(() => {
  writes.length = 0;
  resolveModelForRiskMock.mockReset();
  generateTextMock.mockReset();
  resolveModelForRiskMock.mockResolvedValue({ __stub: true });
});

describe('HelperBotService.ask', () => {
  it('happy path (no history): returns answer + token usage and writes a log with turn_index 0', async () => {
    generateTextMock.mockResolvedValue({
      text: 'Hello world',
      usage: { inputTokens: 1234, outputTokens: 56 },
    });

    const svc = new HelperBotService();
    const result = await svc.ask('how do I configure MCP?', 'usr_42');

    expect(result.answer).toBe('Hello world');
    expect(result.prompt_tokens).toBe(1234);
    expect(result.completion_tokens).toBe(56);
    expect(typeof result.latency_ms).toBe('number');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);

    // Goes through risk-based resolution ('low' — cheap/fast) instead of a
    // hardcoded provider literal, so it inherits the enabled-flag
    // enforcement and Firestore/env precedence chain (#1099).
    expect(resolveModelForRiskMock).toHaveBeenCalledWith('low');
    expect(assembleSystemPrompt).toHaveBeenCalled();
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { __stub: true },
        system: 'SYSTEM_PROMPT',
        messages: [{ role: 'user', content: 'how do I configure MCP?' }],
      }),
    );

    expect(writes).toHaveLength(1);
    const log = writes[0]?.data as Record<string, unknown>;
    expect(log.user_id).toBe('usr_42');
    expect(log.question).toBe('how do I configure MCP?');
    expect(log.answer_preview).toBe('Hello world');
    expect(log.prompt_tokens).toBe(1234);
    expect(log.completion_tokens).toBe(56);
    expect(log.turn_index).toBe(0);
    expect(typeof log.log_id).toBe('string');
    expect((log.log_id as string).startsWith('hbl_')).toBe(true);
    expect(typeof log.created_at).toBe('string');
  });

  it('multi-turn: passes history then current question to generateText', async () => {
    generateTextMock.mockResolvedValue({
      text: 'second answer',
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    const history = [
      { role: 'user' as const, content: 'first q' },
      { role: 'assistant' as const, content: 'first a' },
    ];
    await new HelperBotService().ask('second q', 'usr_1', history);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: 'first q' },
          { role: 'assistant', content: 'first a' },
          { role: 'user', content: 'second q' },
        ],
      }),
    );
    const log = writes[0]?.data as Record<string, unknown>;
    // Only the latest user turn is persisted on the log row.
    expect(log.question).toBe('second q');
    // turn_index reflects the position of the new turn (one prior user turn).
    expect(log.turn_index).toBe(1);
  });

  it('caps history at MAX_HISTORY_TURNS, dropping oldest turns', async () => {
    generateTextMock.mockResolvedValue({
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    // Build 14 alternating turns — 7 user + 7 assistant.
    const history = Array.from({ length: 14 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `turn-${i}`,
    }));

    await new HelperBotService().ask('current', 'usr_1', history);

    const call = generateTextMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    // 10 history turns + 1 current.
    expect(call.messages).toHaveLength(MAX_HISTORY_TURNS + 1);
    // Oldest survivor should be turn-4 (we kept the last 10 of 14).
    expect(call.messages[0]).toEqual({ role: 'user', content: 'turn-4' });
    expect(call.messages[call.messages.length - 1]).toEqual({
      role: 'user',
      content: 'current',
    });
  });

  it('truncates answer_preview to 500 chars', async () => {
    const long = 'x'.repeat(800);
    generateTextMock.mockResolvedValue({
      text: long,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await new HelperBotService().ask('q', 'usr_1');
    const log = writes[0]?.data as Record<string, unknown>;
    expect((log.answer_preview as string).length).toBe(500);
  });

  it('propagates LLM errors to the caller', async () => {
    generateTextMock.mockRejectedValue(new Error('boom'));
    await expect(new HelperBotService().ask('q', 'usr_1')).rejects.toThrow('boom');
    expect(writes).toHaveLength(0);
  });
});
