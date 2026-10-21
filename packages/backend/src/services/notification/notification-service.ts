import type { Notification, NotificationPage, CreateNotificationInput } from '@arbitra/shared';
import { NotFoundError } from '@arbitra/shared';
import { NotificationRepository, type ListPageOptions } from './notification-repository.js';
import { generateId } from '../../lib/ids.js';

export class NotificationService {
  constructor(
    private readonly notificationRepo = new NotificationRepository(),
  ) {}

  /**
   * Create-or-refresh (issue #794 P0 dedup) — see
   * `NotificationRepository.createOrRefresh` for the coalescing rule and its
   * concurrency-safety argument. Callers never see the difference between a
   * fresh row and a refreshed one; both return the current `Notification`.
   */
  async notify(input: CreateNotificationInput): Promise<Notification> {
    const candidate: Notification = {
      notification_id: generateId('notification'),
      user_id: input.user_id,
      type: input.type,
      title: input.title,
      body: input.body,
      case_id: input.case_id,
      read: false,
      created_at: new Date().toISOString(),
    };

    const { notification } = await this.notificationRepo.createOrRefresh(candidate);
    return notification;
  }

  /**
   * Cursor-paginated page of a user's notifications, newest first, plus
   * their TOTAL unread count (issue #794 P0 — see `NotificationPage`'s doc
   * comment). `options` are all optional so a request with none of them
   * (an old client predating this contract) still gets a valid first page.
   */
  async listNotifications(userId: string, options: ListPageOptions = {}): Promise<NotificationPage> {
    return this.notificationRepo.listPage(userId, options);
  }

  /**
   * Neither this nor `delete` previously verified
   * ownership — any authenticated user could mark or delete any other
   * user's notification by id. Mirrors the tokens DELETE ownership pattern
   * (`tokens/route.ts`): a missing doc and a doc owned by someone else both
   * 404, so a caller can't distinguish "no such notification" from "not
   * yours" by probing ids.
   */
  async markAsRead(notificationId: string, userId: string): Promise<void> {
    const notification = await this.notificationRepo.getById(notificationId);
    if (!notification || notification.user_id !== userId) {
      throw new NotFoundError('Notification', notificationId);
    }
    return this.notificationRepo.markAsRead(notificationId);
  }

  /**
   * Bulk mark-all-as-read, scoped server-side to every unread row the user
   * owns — see `NotificationRepository.markAllAsRead`. Needed once the list
   * is paginated: a client can only ever "mark all" the rows it has loaded.
   */
  async markAllAsRead(userId: string): Promise<number> {
    return this.notificationRepo.markAllAsRead(userId);
  }

  /**
   * Reconciles stale `gate_pending` notifications for a case once its gate
   * has actually been decided — see
   * `NotificationRepository.markStaleGatePending` for the exact scope (issue
   * #794 P0 staleness fix, deliberately limited to this one supersession).
   */
  async reconcileGateDecision(caseId: string): Promise<number> {
    return this.notificationRepo.markStaleGatePending(caseId);
  }

  /**
   * Reconciles stale `case_needs_decision` notifications for a case once the
   * decision it asked for has actually happened — see
   * `NotificationRepository.markStaleCaseNeedsDecision` for the exact scope
   * (issue #1073, split out of #794).
   */
  async reconcileCaseNeedsDecision(caseId: string): Promise<number> {
    return this.notificationRepo.markStaleCaseNeedsDecision(caseId);
  }

  async delete(notificationId: string, userId: string): Promise<void> {
    const notification = await this.notificationRepo.getById(notificationId);
    if (!notification || notification.user_id !== userId) {
      throw new NotFoundError('Notification', notificationId);
    }
    return this.notificationRepo.delete(notificationId);
  }
}
