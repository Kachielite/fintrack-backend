import { inject, injectable } from 'tsyringe';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { InsightSchema } from './insight.schema';
import { IInsight } from './insight.interface';

export interface IInsightRepository {
  create(data: {
    userId: number;
    type: string;
    message: string;
    contextData?: unknown;
    expiresAt?: Date;
  }): Promise<IInsight>;
  findActive(userId: number, unreadOnly: boolean): Promise<IInsight[]>;
  markRead(id: number, userId: number): Promise<void>;
  hasRecentInsight(userId: number, type: string, since: Date): Promise<boolean>;
  deleteExpired(userId: number): Promise<void>;
}

@injectable()
class InsightRepositoryImpl implements IInsightRepository {
  constructor(@inject(Database) private db: Database) {}

  async create(data: {
    userId: number;
    type: string;
    message: string;
    contextData?: unknown;
    expiresAt?: Date;
  }): Promise<IInsight> {
    const [row] = await this.db.client
      .insert(InsightSchema)
      .values({
        userId: data.userId,
        type: data.type,
        message: data.message,
        contextData: data.contextData as any,
        expiresAt: data.expiresAt,
      })
      .returning();
    return row as IInsight;
  }

  async findActive(userId: number, unreadOnly: boolean): Promise<IInsight[]> {
    const now = new Date();
    const conditions: any[] = [
      eq(InsightSchema.userId, userId),
      or(isNull(InsightSchema.expiresAt), gt(InsightSchema.expiresAt, now)),
    ];
    if (unreadOnly) conditions.push(eq(InsightSchema.isRead, false));

    return (await this.db.client
      .select()
      .from(InsightSchema)
      .where(and(...conditions))
      .orderBy(sql`${InsightSchema.createdAt} desc`)) as IInsight[];
  }

  async markRead(id: number, userId: number): Promise<void> {
    await this.db.client
      .update(InsightSchema)
      .set({ isRead: true })
      .where(and(eq(InsightSchema.id, id), eq(InsightSchema.userId, userId)));
  }

  async hasRecentInsight(userId: number, type: string, since: Date): Promise<boolean> {
    const rows = await this.db.client
      .select({ id: InsightSchema.id })
      .from(InsightSchema)
      .where(
        and(
          eq(InsightSchema.userId, userId),
          eq(InsightSchema.type, type),
          gt(InsightSchema.createdAt, since),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async deleteExpired(userId: number): Promise<void> {
    const now = new Date();
    await this.db.client
      .delete(InsightSchema)
      .where(
        and(
          eq(InsightSchema.userId, userId),
          lte(InsightSchema.expiresAt, now),
        ),
      );
  }
}

export default InsightRepositoryImpl;
