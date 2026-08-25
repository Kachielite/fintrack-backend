import { inject, injectable } from 'tsyringe';
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
}

export default TransferLinkRepositoryImpl;
