/**
 * Neither `DELETE /api/notifications/:id` nor
 * `POST /api/notifications/:id/read` verified the caller owned the
 * notification before mutating it — any authenticated user could act on
 * any other user's row by id. These tests pin the ownership check added to
 * `NotificationService`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, type Notification } from '@arbitra/shared';

const { getById, markAsReadRepo, deleteRepo } = vi.hoisted(() => ({
  getById: vi.fn(),
  markAsReadRepo: vi.fn(),
  deleteRepo: vi.fn(),
}));

vi.mock('./notification-repository.js', () => ({
  NotificationRepository: class {
    getById = getById;
    markAsRead = markAsReadRepo;
    delete = deleteRepo;
  },
}));

import { NotificationService } from './notification-service.js';

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    notification_id: 'notif_1',
    user_id: 'usr_owner',
    type: 'case_needs_decision',
    title: 'T',
    body: 'B',
    read: false,
    created_at: '2026-07-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('NotificationService — ownership checks', () => {
  const service = new NotificationService();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('delete', () => {
    it('rejects with NotFoundError when the notification belongs to a different user', async () => {
      getById.mockResolvedValueOnce(makeNotification({ user_id: 'usr_owner' }));
      await expect(service.delete('notif_1', 'usr_other')).rejects.toBeInstanceOf(NotFoundError);
      expect(deleteRepo).not.toHaveBeenCalled();
    });

    it('rejects with NotFoundError when the notification does not exist', async () => {
      getById.mockResolvedValueOnce(null);
      await expect(service.delete('notif_missing', 'usr_owner')).rejects.toBeInstanceOf(NotFoundError);
      expect(deleteRepo).not.toHaveBeenCalled();
    });

    it('deletes when the caller owns the notification', async () => {
      getById.mockResolvedValueOnce(makeNotification({ user_id: 'usr_owner' }));
      await service.delete('notif_1', 'usr_owner');
      expect(deleteRepo).toHaveBeenCalledWith('notif_1');
    });
  });

  describe('markAsRead', () => {
    it('rejects with NotFoundError when the notification belongs to a different user', async () => {
      getById.mockResolvedValueOnce(makeNotification({ user_id: 'usr_owner' }));
      await expect(service.markAsRead('notif_1', 'usr_other')).rejects.toBeInstanceOf(NotFoundError);
      expect(markAsReadRepo).not.toHaveBeenCalled();
    });

    it('rejects with NotFoundError when the notification does not exist', async () => {
      getById.mockResolvedValueOnce(null);
      await expect(service.markAsRead('notif_missing', 'usr_owner')).rejects.toBeInstanceOf(NotFoundError);
      expect(markAsReadRepo).not.toHaveBeenCalled();
    });

    it('marks read when the caller owns the notification', async () => {
      getById.mockResolvedValueOnce(makeNotification({ user_id: 'usr_owner' }));
      await service.markAsRead('notif_1', 'usr_owner');
      expect(markAsReadRepo).toHaveBeenCalledWith('notif_1');
    });
  });
});
