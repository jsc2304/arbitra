/**
 * Issue #794 P0 — thin delegation tests for `NotificationService`'s new
 * dedup/pagination/reconciliation surface. The actual dedup, pagination, and
 * reconciliation LOGIC is exercised against a real (faked) Firestore in
 * `notification-repository.test.ts`; these tests only pin that the service
 * wires each call through to the right repository method with the right
 * arguments, and returns what the repository returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Notification } from '@arbitra/shared';

const { createOrRefresh, listPage, markAllAsReadRepo, markStaleGatePending, markStaleCaseNeedsDecision } = vi.hoisted(() => ({
  createOrRefresh: vi.fn(),
  listPage: vi.fn(),
  markAllAsReadRepo: vi.fn(),
  markStaleGatePending: vi.fn(),
  markStaleCaseNeedsDecision: vi.fn(),
}));

vi.mock('./notification-repository.js', () => ({
  NotificationRepository: class {
    createOrRefresh = createOrRefresh;
    listPage = listPage;
    markAllAsRead = markAllAsReadRepo;
    markStaleGatePending = markStaleGatePending;
    markStaleCaseNeedsDecision = markStaleCaseNeedsDecision;
  },
}));

import { NotificationService } from './notification-service.js';

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    notification_id: 'notif_1',
    user_id: 'usr_1',
    type: 'gate_pending',
    title: 'T',
    body: 'B',
    case_id: 'case_1',
    read: false,
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('NotificationService — issue #794 P0 delegation', () => {
  const service = new NotificationService();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('notify() builds a candidate and returns whatever createOrRefresh resolves (created or refreshed)', async () => {
    const refreshed = makeNotification({ title: 'refreshed title' });
    createOrRefresh.mockResolvedValueOnce({ notification: refreshed, outcome: 'refreshed' });

    const result = await service.notify({
      user_id: 'usr_1',
      type: 'gate_pending',
      title: 'new title',
      body: 'new body',
      case_id: 'case_1',
    });

    expect(createOrRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'usr_1', type: 'gate_pending', title: 'new title', case_id: 'case_1', read: false }),
    );
    expect(result).toBe(refreshed);
  });

  it('listNotifications() forwards cursor/limit options and returns the repository page unchanged', async () => {
    const page = { notifications: [makeNotification()], next_cursor: 'c1', unread_count: 5 };
    listPage.mockResolvedValueOnce(page);

    const result = await service.listNotifications('usr_1', { cursor: 'abc', limit: 10 });

    expect(listPage).toHaveBeenCalledWith('usr_1', { cursor: 'abc', limit: 10 });
    expect(result).toBe(page);
  });

  it('markAllAsRead() delegates to the repository and returns its count', async () => {
    markAllAsReadRepo.mockResolvedValueOnce(3);

    const result = await service.markAllAsRead('usr_1');

    expect(markAllAsReadRepo).toHaveBeenCalledWith('usr_1');
    expect(result).toBe(3);
  });

  it('reconcileGateDecision() delegates to markStaleGatePending and returns its count', async () => {
    markStaleGatePending.mockResolvedValueOnce(2);

    const result = await service.reconcileGateDecision('case_1');

    expect(markStaleGatePending).toHaveBeenCalledWith('case_1');
    expect(result).toBe(2);
  });

  it('reconcileCaseNeedsDecision() delegates to markStaleCaseNeedsDecision and returns its count', async () => {
    markStaleCaseNeedsDecision.mockResolvedValueOnce(3);

    const result = await service.reconcileCaseNeedsDecision('case_1');

    expect(markStaleCaseNeedsDecision).toHaveBeenCalledWith('case_1');
    expect(result).toBe(3);
  });
});
