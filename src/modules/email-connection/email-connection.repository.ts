import { inject, injectable } from 'tsyringe';
import { and, eq } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { EmailConnectionSchema } from './email-connection.schema';
import {
  IEmailConnection,
  ICreateEmailConnection,
  IUpdateLabel,
} from './email-connection.interface';

export interface IEmailConnectionRepository {
  create(data: ICreateEmailConnection): Promise<IEmailConnection>;
  findById(id: number, userId: number): Promise<IEmailConnection | null>;
  findAllByUser(userId: number): Promise<IEmailConnection[]>;
  findAllActive(): Promise<IEmailConnection[]>;
  updateLabel(id: number, userId: number, data: IUpdateLabel): Promise<IEmailConnection>;
  updateTokens(
    id: number,
    encryptedAccessToken: string,
    tokenExpiresAt: Date,
  ): Promise<void>;
  updateLastSynced(id: number, messageCount: number): Promise<void>;
  updateStatus(id: number, status: string): Promise<void>;
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
      .where(eq(EmailConnectionSchema.status, 'active'))) as IEmailConnection[];
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

  async delete(id: number, userId: number): Promise<void> {
    await this.db.client
      .delete(EmailConnectionSchema)
      .where(and(eq(EmailConnectionSchema.id, id), eq(EmailConnectionSchema.userId, userId)));
  }
}

export default EmailConnectionRepositoryImpl;
