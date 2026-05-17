import { inject, injectable } from 'tsyringe';
import NotificationRepositoryImpl, { INotificationRepository } from './notification.repository';
import { INotification, ICreateNotification } from './notification.interface';
import { mapNotificationToDto, NotificationResponseDto, UnreadCountDto } from './notification.dto';
import { ResourceNotFoundException } from '@/common/exception';
import { sendPushNotification } from '@/common/lib/push';
import { IGeneralResponse } from '@/common/types/interface';
import logger from '@/common/lib/logger';

export interface INotificationService {
  create(data: ICreateNotification): Promise<INotification>;
  list(userId: number): Promise<NotificationResponseDto[]>;
  markRead(id: number, userId: number): Promise<void>;
  markAllRead(userId: number): Promise<void>;
  getUnreadCount(userId: number): Promise<UnreadCountDto>;
  registerDeviceToken(userId: number, playerId: string, platform?: string): Promise<IGeneralResponse<null>>;
  removeDeviceToken(userId: number, playerId: string): Promise<IGeneralResponse<null>>;
}

@injectable()
class NotificationService implements INotificationService {
  private hasWarnedMissingDeviceTokensTable = false;

  constructor(
    @inject('INotificationRepository') private repo: INotificationRepository,
  ) {}

  /**
   * Saves an in-app notification, then dispatches a push to all of the user's
   * registered devices. The push is fire-and-forget — it never blocks the caller.
   */
  async create(data: ICreateNotification): Promise<INotification> {
    logger.info(`[Notification] Creating notification for user ${data.userId} (type=${data.type})`);
    const notification = await this.repo.create(data);
    this.dispatchPush(data.userId, data.title, data.body, { type: data.type, ...(data.data ?? {}) }).catch(() => {});
    return notification;
  }

  async list(userId: number): Promise<NotificationResponseDto[]> {
    logger.info(`[Notification] Listing notifications for user ${userId}`);
    const rows = await this.repo.findByUser(userId);
    return rows.reverse().map(mapNotificationToDto);
  }

  async markRead(id: number, userId: number): Promise<void> {
    logger.info(`[Notification] Marking notification ${id} as read for user ${userId}`);
    const rows = await this.repo.findByUser(userId);
    const notification = rows.find((n) => n.id === id);
    if (!notification) throw new ResourceNotFoundException('Notification not found');
    await this.repo.markRead(id, userId);
  }

  async markAllRead(userId: number): Promise<void> {
    logger.info(`[Notification] Marking all notifications as read for user ${userId}`);
    await this.repo.markAllRead(userId);
  }

  async getUnreadCount(userId: number): Promise<UnreadCountDto> {
    logger.info(`[Notification] Fetching unread count for user ${userId}`);
    const count = await this.repo.countUnread(userId);
    return { count };
  }

  async registerDeviceToken(userId: number, playerId: string, platform?: string): Promise<IGeneralResponse<null>> {
    await this.repo.upsertDeviceToken(userId, playerId, platform);
    logger.info(`[Push] Device token registered for user ${userId} (platform=${platform ?? 'unknown'})`);
    return { success: true, message: 'Device token registered', data: null };
  }

  async removeDeviceToken(userId: number, playerId: string): Promise<IGeneralResponse<null>> {
    await this.repo.removeDeviceToken(userId, playerId);
    logger.info(`[Push] Device token removed for user ${userId}`);
    return { success: true, message: 'Device token removed', data: null };
  }

  private async dispatchPush(
    userId: number,
    title: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      const tokens = await this.repo.findTokensByUser(userId);
      const playerIds = tokens.map((t) => t.playerId);
      if (playerIds.length === 0) {
        logger.debug(`[Push] No device tokens registered for user ${userId} — skipping push`);
        return;
      }
      await sendPushNotification(playerIds, title, body, data);
    } catch (error) {
      if (this.isMissingDeviceTokensTableError(error)) {
        if (!this.hasWarnedMissingDeviceTokensTable) {
          this.hasWarnedMissingDeviceTokensTable = true;
          logger.warn('[Push] device_tokens table is missing. Run DB migrations to enable push notifications.');
        }
        return;
      }
      logger.warn(`[Push] Dispatch failed for user ${userId}: ${error}`);
    }
  }

  private isMissingDeviceTokensTableError(error: unknown): boolean {
    const err = error as { code?: string; message?: string };
    if (err?.code === '42P01') return true;
    const msg = String(err?.message || '').toLowerCase();
    return msg.includes('relation') && msg.includes('device_tokens') && msg.includes('does not exist');
  }
}

export default NotificationService;
