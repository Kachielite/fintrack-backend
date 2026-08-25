import { inject, injectable } from 'tsyringe';
import { eq, or } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { TransferLinkSchema } from './transfer-link.schema';
import { ITransferLink } from './transfer-link.interface';

export interface ITransferLinkRepository {
  create(data: {
    userId: number;
    fromTransactionId: number | null;
    toTransactionId: number | null;
    linkType: string;
    confidence: string;
  }): Promise<ITransferLink>;
  findByTransactionId(transactionId: number): Promise<ITransferLink | null>;
  delete(id: number): Promise<void>;
}

@injectable()
class TransferLinkRepositoryImpl implements ITransferLinkRepository {
  constructor(@inject(Database) private db: Database) {}

  async create(data: {
    userId: number;
    fromTransactionId: number | null;
    toTransactionId: number | null;
    linkType: string;
    confidence: string;
  }): Promise<ITransferLink> {
    const created = await this.db.client
      .insert(TransferLinkSchema)
      .values({
        userId: data.userId,
        fromTransactionId: data.fromTransactionId,
        toTransactionId: data.toTransactionId,
        linkType: data.linkType,
        confidence: data.confidence,
      })
      .returning();
    return created[0] as ITransferLink;
  }

  async findByTransactionId(transactionId: number): Promise<ITransferLink | null> {
    const rows = await this.db.client
      .select()
      .from(TransferLinkSchema)
      .where(
        or(
          eq(TransferLinkSchema.fromTransactionId, transactionId),
          eq(TransferLinkSchema.toTransactionId, transactionId),
        ),
      )
      .limit(1);
    return (rows[0] as ITransferLink) ?? null;
  }

  async delete(id: number): Promise<void> {
    await this.db.client.delete(TransferLinkSchema).where(eq(TransferLinkSchema.id, id));
  }
}

export default TransferLinkRepositoryImpl;
