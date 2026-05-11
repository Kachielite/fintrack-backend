import { inject, injectable } from 'tsyringe';
import NotificationRepositoryImpl, { INotificationRepository } from './notification.repository';
import { INotification, ICreateNotification } from './notification.interface';
import { mapNotificationToDto, NotificationResponseDto, UnreadCountDto } from './notification.dto';
import { ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';

export interface INotificationService {
  create(data: ICreateNotification): Promise<INotification>;
  list(userId: number): Promise<NotificationResponseDto[]>;
  markRead(id: number, userId: number): Promise<void>;
  markAllRead(userId: number): Promise<void>;
  getUnreadCount(userId: number): Promise<UnreadCountDto>;
}

@injectable()
class NotificationService implements INotificationService {
  constructor(
    @inject('INotificationRepository') private repo: INotificationRepository,
  ) {}

  async create(data: ICreateNotification): Promise<INotification> {
    logger.info(`[Notification] Creating notification for user ${data.userId} (type=${data.type})`);
    return this.repo.create(data);
  }

  async list(userId: number): Promise<NotificationResponseDto[]> {
    logger.info(`[Notification] Listing notifications for user ${userId}`);
    const rows = await this.repo.findByUser(userId);
    return rows.reverse().map(mapNotificationToDto); // newest first
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
}

export default NotificationService;
