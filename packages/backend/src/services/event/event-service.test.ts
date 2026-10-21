/**
 * EventService — first test suite covering the transactional-notification
 * seam (spec `docs/specs/clerk-config-scheduling-chat.md`, slice C item 1/4).
 *
 * Pre-fix, `emitInTransaction` never notified at all — a silent bypass for
 * every event emitted via a Firestore transaction (`case_completed`,
 * `case_approved`, `assistant_task_completed`, …). These tests pin the fix's
 * two halves: `emitInTransaction` itself still never notifies inline (a
 * transaction can still abort after it returns), and `notifyCommitted` is
 * the caller-invoked hook that actually reaches the notifier, using events
 * `emitInTransaction` already returned.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CaseEvent } from '@arbitra/shared';
import type { EventRepository } from './event-repository.js';
import type { EventNotifier } from '../notification/event-notifier.js';
import { EventService } from './event-service.js';

function makeFakeRepo() {
  return {
    create: vi.fn(async (event: CaseEvent) => event),
    createInTransaction: vi.fn(),
    getByCaseId: vi.fn(async () => []),
  } as unknown as EventRepository;
}

function makeFakeNotifier() {
  return {
    onCaseEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventNotifier;
}

const FAKE_TX = {} as FirebaseFirestore.Transaction;

describe('EventService.emit — the plain (non-transactional) path', () => {
  it('notifies inline, fire-and-forget, after the write', async () => {
    const repo = makeFakeRepo();
    const notifier = makeFakeNotifier();
    const service = new EventService(repo, notifier);

    await service.emit('case_1', 'case_completed', { to_status: 'done' }, 'system:test');
    await Promise.resolve();

    expect(notifier.onCaseEvent).toHaveBeenCalledWith(
      'case_1', 'case_completed', { to_status: 'done' }, 'system:test',
    );
  });
});

describe('EventService.emitInTransaction — never notifies by itself', () => {
  it('stages the write and returns the CaseEvent, without calling the notifier', async () => {
    // Reverting this to call `this.notifier.onCaseEvent(...)` inline (mirroring
    // `emit()`) would notify for a transaction that has not committed yet —
    // and might never commit at all.
    const repo = makeFakeRepo();
    const notifier = makeFakeNotifier();
    const service = new EventService(repo, notifier);

    const event = await service.emitInTransaction(FAKE_TX, 'case_1', 'case_completed', { to_status: 'done' }, 'system:test');

    expect(repo.createInTransaction).toHaveBeenCalledWith(FAKE_TX, event);
    expect(event).toMatchObject({ case_id: 'case_1', type: 'case_completed', actor_id: 'system:test' });

    await Promise.resolve();
    expect(notifier.onCaseEvent).not.toHaveBeenCalled();
  });
});

describe('EventService.notifyCommitted — the post-commit hook', () => {
  it('notifies for every event passed, using the same notifier `emit()` uses', async () => {
    const repo = makeFakeRepo();
    const notifier = makeFakeNotifier();
    const service = new EventService(repo, notifier);

    const e1 = await service.emitInTransaction(FAKE_TX, 'case_1', 'case_completed', { to_status: 'done' }, 'system:test');
    const e2 = await service.emitInTransaction(FAKE_TX, 'case_1', 'assistant_task_completed', { run_id: 'run_1' }, 'system:clerk');

    // Not yet — nothing has told EventService the transaction committed.
    expect(notifier.onCaseEvent).not.toHaveBeenCalled();

    service.notifyCommitted([e1, e2]);
    await Promise.resolve();

    expect(notifier.onCaseEvent).toHaveBeenCalledTimes(2);
    expect(notifier.onCaseEvent).toHaveBeenNthCalledWith(1, 'case_1', 'case_completed', { to_status: 'done' }, 'system:test');
    expect(notifier.onCaseEvent).toHaveBeenNthCalledWith(2, 'case_1', 'assistant_task_completed', { run_id: 'run_1' }, 'system:clerk');
  });

  it('is a no-op for an empty list — nothing staged, nothing notified', async () => {
    const repo = makeFakeRepo();
    const notifier = makeFakeNotifier();
    const service = new EventService(repo, notifier);

    service.notifyCommitted([]);
    await Promise.resolve();

    expect(notifier.onCaseEvent).not.toHaveBeenCalled();
  });

  it('logs and swallows a notifier failure — one bad event must not lose the notifications for the rest', async () => {
    const repo = makeFakeRepo();
    const notifier = makeFakeNotifier();
    vi.mocked(notifier.onCaseEvent)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new EventService(repo, notifier);

    const e1 = await service.emitInTransaction(FAKE_TX, 'case_1', 'case_completed', {}, 'system:test');
    const e2 = await service.emitInTransaction(FAKE_TX, 'case_1', 'case_approved', {}, 'system:test');

    service.notifyCommitted([e1, e2]);
    await Promise.resolve();
    await Promise.resolve();

    expect(notifier.onCaseEvent).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
