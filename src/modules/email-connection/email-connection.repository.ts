import { inject, injectable } from 'tsyringe';
import { and, eq, isNotNull } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { EmailConnectionSchema } from './email-connection.schema';
import {
  IEmailConnection,
  ICreateEmailConnection,
  IUpdateEmailConnection,
  IUpdateLabel,
} from './email-connection.interface';

export interface IEmailConnectionRepository {
  create(data: ICreateEmailConnection): Promise<IEmailConnection>;
  findById(id: number, userId: number): Promise<IEmailConnection | null>;
  findByIdOnly(id: number): Promise<IEmailConnection | null>;
  findByUserAndEmail(userId: number, gmailAddress: string): Promise<IEmailConnection | null>;
  findAllByUser(userId: number): Promise<IEmailConnection[]>;
  findAllActive(): Promise<IEmailConnection[]>;
  update(id: number, data: IUpdateEmailConnection): Promise<IEmailConnection>;
  updateLabel(id: number, userId: number, data: IUpdateLabel): Promise<IEmailConnection>;
  updateTokens(
    id: number,
    encryptedAccessToken: string,
    tokenExpiresAt: Date,
  ): Promise<void>;
  updateLastSynced(id: number, messageCount: number): Promise<void>;
  updateStatus(id: number, status: string): Promise<void>;
  updateBackfillPending(id: number, pending: boolean): Promise<void>;
  /** True if any of this user's connections still has a chunked backfill in progress. */
  hasActiveBackfill(userId: number): Promise<boolean>;
  /**
   * Increments and returns this connection's AI extraction call count for
   * today, resetting to 1 first if the stored counter is from an earlier day.
   * Used as a per-connection daily cost circuit breaker (fintrack-backend#166).
   */
  incrementAiExtractionCallCount(id: number): Promise<number>;
  delete(id: number, userId: number): Promise<void>;
}

@injectable()
class EmailConnectionRepositoryImpl implements IEmailConnectionRepository {
  constructor(@inject(Database) private db: Database) {}

  async create(data: ICreateEmailConnection): Promise<IEmailConnection> {
    const [row] = await this.db.client
      .insert(EmailConnectionSchema)
      .values(data)
      .returning();
    return row as IEmailConnection;
  }

  async findById(id: number, userId: number): Promise<IEmailConnection | null> {
    const rows = await this.db.client
      .select()
      .from(EmailConnectionSchema)
      .where(and(eq(EmailConnectionSchema.id, id), eq(EmailConnectionSchema.userId, userId)))
      .limit(1);
    return (rows[0] as IEmailConnection) ?? null;
  }

  async findByIdOnly(id: number): Promise<IEmailConnection | null> {
    const rows = await this.db.client
      .select()
      .from(EmailConnectionSchema)
      .where(eq(EmailConnectionSchema.id, id))
      .limit(1);
    return (rows[0] as IEmailConnection) ?? null;
  }

  async findByUserAndEmail(userId: number, gmailAddress: string): Promise<IEmailConnection | null> {
    const rows = await this.db.client
      .select()
      .from(EmailConnectionSchema)
      .where(and(eq(EmailConnectionSchema.userId, userId), eq(EmailConnectionSchema.gmailAddress, gmailAddress)))
      .limit(1);
    return (rows[0] as IEmailConnection) ?? null;
  }

  async findAllByUser(userId: number): Promise<IEmailConnection[]> {
    return (await this.db.client
      .select()
      .from(EmailConnectionSchema)
      .where(eq(EmailConnectionSchema.userId, userId))) as IEmailConnection[];
  }

  async findAllActive(): Promise<IEmailConnection[]> {
    return (await this.db.client
      .select()
      .from(EmailConnectionSchema)
      .where(
        and(
          eq(EmailConnectionSchema.status, 'active'),
          isNotNull(EmailConnectionSchema.gmailLabelId),
        ),
      )) as IEmailConnection[];
  }

  async update(id: number, data: IUpdateEmailConnection): Promise<IEmailConnection> {
    const [row] = await this.db.client
      .update(EmailConnectionSchema)
      .set({
        encryptedAccessToken: data.encryptedAccessToken,
        encryptedRefreshToken: data.encryptedRefreshToken,
        tokenExpiresAt: data.tokenExpiresAt,
        gmailLabelId: data.gmailLabelId,
        gmailLabelName: data.gmailLabelName,
        status: data.status,
        updatedAt: new Date(),
      })
      .where(eq(EmailConnectionSchema.id, id))
      .returning();
    return row as IEmailConnection;
  }

  async updateLabel(id: number, userId: number, data: IUpdateLabel): Promise<IEmailConnection> {
    const [row] = await this.db.client
      .update(EmailConnectionSchema)
      .set({
        gmailLabelId: data.gmailLabelId,
        gmailLabelName: data.gmailLabelName,
        updatedAt: new Date(),
      })
      .where(and(eq(EmailConnectionSchema.id, id), eq(EmailConnectionSchema.userId, userId)))
      .returning();
    return row as IEmailConnection;
  }

  async updateTokens(
    id: number,
    encryptedAccessToken: string,
    tokenExpiresAt: Date,
  ): Promise<void> {
    await this.db.client
      .update(EmailConnectionSchema)
      .set({ encryptedAccessToken, tokenExpiresAt, updatedAt: new Date() })
      .where(eq(EmailConnectionSchema.id, id));
  }

  async updateLastSynced(id: number, messageCount: number): Promise<void> {
    await this.db.client
      .update(EmailConnectionSchema)
      .set({
        lastSyncedAt: new Date(),
        lastSyncMessageCount: messageCount,
        updatedAt: new Date(),
      })
      .where(eq(EmailConnectionSchema.id, id));
  }

  async updateStatus(id: number, status: string): Promise<void> {
    await this.db.client
      .update(EmailConnectionSchema)
      .set({ status, updatedAt: new Date() })
      .where(eq(EmailConnectionSchema.id, id));
  }

  async updateBackfillPending(id: number, pending: boolean): Promise<void> {
    await this.db.client
      .update(EmailConnectionSchema)
      .set({ backfillPending: pending, updatedAt: new Date() })
      .where(eq(EmailConnectionSchema.id, id));
  }

  async incrementAiExtractionCallCount(id: number): Promise<number> {
    const [row] = await this.db.client
      .select({
        aiExtractionCallsToday: EmailConnectionSchema.aiExtractionCallsToday,
        aiExtractionCallsResetAt: EmailConnectionSchema.aiExtractionCallsResetAt,
      })
      .from(EmailConnectionSchema)
      .where(eq(EmailConnectionSchema.id, id))
      .limit(1);
    if (!row) return 0;

    const now = new Date();
    const isSameUtcDay =
      row.aiExtractionCallsResetAt != null &&
      row.aiExtractionCallsResetAt.getUTCFullYear() === now.getUTCFullYear() &&
      row.aiExtractionCallsResetAt.getUTCMonth() === now.getUTCMonth() &&
      row.aiExtractionCallsResetAt.getUTCDate() === now.getUTCDate();

    const newCount = isSameUtcDay ? row.aiExtractionCallsToday + 1 : 1;
    await this.db.client
      .update(EmailConnectionSchema)
      .set({ aiExtractionCallsToday: newCount, aiExtractionCallsResetAt: now, updatedAt: now })
      .where(eq(EmailConnectionSchema.id, id));
    return newCount;
  }

  async hasActiveBackfill(userId: number): Promise<boolean> {
    const rows = await this.db.client
      .select({ id: EmailConnectionSchema.id })
      .from(EmailConnectionSchema)
      .where(and(eq(EmailConnectionSchema.userId, userId), eq(EmailConnectionSchema.backfillPending, true)))
      .limit(1);
    return rows.length > 0;
  }

  async delete(id: number, userId: number): Promise<void> {
    await this.db.client
      .delete(EmailConnectionSchema)
      .where(and(eq(EmailConnectionSchema.id, id), eq(EmailConnectionSchema.userId, userId)));
  }
}

export default EmailConnectionRepositoryImpl;
