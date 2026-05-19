import { inject, injectable } from 'tsyringe';
import { and, desc, eq, isNull } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { NotificationSchema } from './notification.schema';
import { DeviceTokenSchema } from './device-token.schema';
import { INotification, ICreateNotification, IDeviceToken } from './notification.interface';

export interface INotificationRepository {
  create(data: ICreateNotification): Promise<INotification>;
  findByUser(userId: number, limit?: number): Promise<INotification[]>;
  markRead(id: number, userId: number): Promise<void>;
  markAllRead(userId: number): Promise<void>;
  countUnread(userId: number): Promise<number>;
  // Device tokens
  upsertDeviceToken(userId: number, playerId: string, platform?: string): Promise<void>;
  findTokensByUser(userId: number): Promise<IDeviceToken[]>;
  removeDeviceToken(userId: number, playerId: string): Promise<void>;
}

@injectable()
class NotificationRepositoryImpl implements INotificationRepository {
  constructor(@inject(Database) private db: Database) {}

  async create(data: ICreateNotification): Promise<INotification> {
    const [row] = await this.db.client
      .insert(NotificationSchema)
      .values({
        userId: data.userId,
        type: data.type,
        title: data.title,
        body: data.body,
        data: data.data ? JSON.stringify(data.data) : null,
      })
      .returning();
    return row as INotification;
  }

  async findByUser(userId: number, limit = 100): Promise<INotification[]> {
    return (await this.db.client
      .select()
      .from(NotificationSchema)
      .where(eq(NotificationSchema.userId, userId))
      .orderBy(desc(NotificationSchema.createdAt))
      .limit(limit)) as INotification[];
  }

  async markRead(id: number, userId: number): Promise<void> {
    await this.db.client
      .update(NotificationSchema)
      .set({ readAt: new Date() })
      .where(and(eq(NotificationSchema.id, id), eq(NotificationSchema.userId, userId)));
  }

  async markAllRead(userId: number): Promise<void> {
    await this.db.client
      .update(NotificationSchema)
      .set({ readAt: new Date() })
      .where(and(eq(NotificationSchema.userId, userId), isNull(NotificationSchema.readAt)));
  }

  async countUnread(userId: number): Promise<number> {
    const rows = await this.db.client
      .select()
      .from(NotificationSchema)
      .where(and(eq(NotificationSchema.userId, userId), isNull(NotificationSchema.readAt)));
    return rows.length;
  }

  async upsertDeviceToken(userId: number, playerId: string, platform?: string): Promise<void> {
    await this.db.client
      .insert(DeviceTokenSchema)
      .values({ userId, playerId, platform: platform ?? null })
      .onConflictDoUpdate({
        target: DeviceTokenSchema.playerId,
        set: { userId, platform: platform ?? null },
      });
  }

  async findTokensByUser(userId: number): Promise<IDeviceToken[]> {
    return (await this.db.client
      .select()
      .from(DeviceTokenSchema)
      .where(eq(DeviceTokenSchema.userId, userId))) as IDeviceToken[];
  }

  async removeDeviceToken(userId: number, playerId: string): Promise<void> {
    await this.db.client
      .delete(DeviceTokenSchema)
      .where(and(eq(DeviceTokenSchema.userId, userId), eq(DeviceTokenSchema.playerId, playerId)));
  }
}

export default NotificationRepositoryImpl;
