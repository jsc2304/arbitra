/**
 * @file Submitting a Clerk task, and wording the intake's refusals.
 *
 * Two behaviours a green suite would otherwise not notice: a first-time user
 * must be provisioned and retried rather than shown an error, and that retry
 * must carry the SAME idempotency key — otherwise a failure after intake's write
 * turns one request into two cases. The refusal wording matters because the
 * intake's 429 already names the cases blocking the user; printing only the
 * message throws that away.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api-client';
import { describeIntakeRefusal, isClerkCoreMissing } from '../clerk-intake-refusal';
import { submitClerkTask } from '../clerk-task-submit';

const created = {
  case_id: 'case_new',
  run_id: 'run_new',
  status: 'open',
  replayed: false,
};

describe('submitClerkTask', () => {
  it('submits a normal Clerk request once without provisioning another service', async () => {
    const createTask = vi.fn().mockResolvedValue(created);
    const provisionClerkCore = vi.fn();

    const result = await submitClerkTask(
      { createTask, provisionClerkCore },
      { text: 'Which cases exist?', idempotencyKey: 'web-abc' },
    );

    expect(result).toBe(created);
    expect(createTask).toHaveBeenCalledOnce();
    expect(createTask).toHaveBeenCalledWith({
      text: 'Which cases exist?',
      idempotency_key: 'web-abc',
    });
    expect(provisionClerkCore).not.toHaveBeenCalled();
  });

  it('provisions and retries with the same idempotency key when no Clerk core exists', async () => {
    const createTask = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError('Clerk is not provisioned', 409, 'CLERK_CORE_NOT_PROVISIONED', {}),
      )
      .mockResolvedValueOnce(created);
    const provisionClerkCore = vi.fn().mockResolvedValue({});

    const result = await submitClerkTask(
      { createTask, provisionClerkCore },
      { text: 'Which cases exist?', idempotencyKey: 'web-abc' },
    );

    expect(result).toBe(created);
    expect(provisionClerkCore).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[0]![0]).toEqual({
      text: 'Which cases exist?',
      idempotency_key: 'web-abc',
    });
    // The key is what makes the retry a replay rather than a second case.
    expect(createTask.mock.calls[1]![0]).toEqual(createTask.mock.calls[0]![0]);
  });

  it('does not provision for a refusal provisioning cannot fix', async () => {
    const limit = new ApiError('You already have 10 active assistant tasks', 429, 'ASSISTANT_INTAKE_LIMIT', {
      limit: 'active_per_user',
    });
    const createTask = vi.fn().mockRejectedValue(limit);
    const provisionClerkCore = vi.fn();

    await expect(
      submitClerkTask({ createTask, provisionClerkCore }, { text: 'x', idempotencyKey: 'web-abc' }),
    ).rejects.toBe(limit);
    expect(provisionClerkCore).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledTimes(1);
  });
});

describe('describeIntakeRefusal', () => {
  it('names the cases holding the active slots', () => {
    const refusal = describeIntakeRefusal(
      new ApiError(
        'You already have 10 active assistant tasks; the limit is 10. Let one finish before starting another.',
        429,
        'ASSISTANT_INTAKE_LIMIT',
        { limit: 'active_per_user', active: 10, max: 10, case_ids: ['case_a', 'case_b'] },
      ),
    );

    expect(refusal.blockingCaseIds).toEqual(['case_a', 'case_b']);
    expect(refusal.message).toContain('the limit is 10');
    expect(refusal.message).toContain('holding your slots');
  });

  it('says when the daily allowance resets', () => {
    const refusal = describeIntakeRefusal(
      new ApiError('You have started 30 assistant tasks today; the daily limit is 30.', 429, 'ASSISTANT_INTAKE_LIMIT', {
        limit: 'daily',
        today: 30,
        max: 30,
      }),
    );

    expect(refusal.message).toContain('resets at 00:00 UTC');
    expect(refusal.blockingCaseIds).toEqual([]);
  });

  it('passes the input-length refusal through with the server-stated limit', () => {
    const refusal = describeIntakeRefusal(
      new ApiError('Assistant task text is 9000 characters; the limit is 8000.', 429, 'ASSISTANT_INTAKE_LIMIT', {
        limit: 'input_chars',
        length: 9000,
        max: 8000,
      }),
    );

    expect(refusal.message).toBe('Assistant task text is 9000 characters; the limit is 8000.');
    expect(refusal.blockingCaseIds).toEqual([]);
  });
});

describe('isClerkCoreMissing', () => {
  it('keys on the error code, not the message', () => {
    expect(
      isClerkCoreMissing(new ApiError('anything', 409, 'CLERK_CORE_NOT_PROVISIONED', {})),
    ).toBe(true);
    expect(isClerkCoreMissing(new ApiError('Clerk is not provisioned', 409, 'OTHER', {}))).toBe(false);
    expect(isClerkCoreMissing(new Error('Clerk is not provisioned'))).toBe(false);
  });
});
