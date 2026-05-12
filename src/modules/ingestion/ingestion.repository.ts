import { inject, injectable } from 'tsyringe';
import { and, count, eq, isNotNull } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { ProcessedEmailSchema } from './ingestion.schema';
import { EmailConnectionSchema } from '@/modules/email-connection/email-connection.schema';
import { TransactionSchema } from '@/modules/transaction/transaction.schema';
import { IProcessedEmail, ICreateProcessedEmail, IConnectionStats } from './ingestion.interface';

export interface IIngestionRepository {
  isAlreadyProcessed(connectionId: number, gmailMessageId: string): Promise<boolean>;
  isAlreadyProcessedForUser(userId: number, gmailMessageId: string): Promise<boolean>;
  markProcessed(data: ICreateProcessedEmail): Promise<IProcessedEmail | null>;
  getConnectionStats(connectionId: number): Promise<IConnectionStats>;
  deleteConnectionData(connectionId: number): Promise<void>;
}

@injectable()
class IngestionRepositoryImpl implements IIngestionRepository {
  constructor(@inject(Database) private db: Database) {}

  async isAlreadyProcessed(connectionId: number, gmailMessageId: string): Promise<boolean> {
    const rows = await this.db.client
      .select({ id: ProcessedEmailSchema.id })
      .from(ProcessedEmailSchema)
      .where(
        and(
          eq(ProcessedEmailSchema.emailConnectionId, connectionId),
          eq(ProcessedEmailSchema.gmailMessageId, gmailMessageId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async isAlreadyProcessedForUser(userId: number, gmailMessageId: string): Promise<boolean> {
    const rows = await this.db.client
      .select({ id: ProcessedEmailSchema.id })
      .from(ProcessedEmailSchema)
      .innerJoin(
        EmailConnectionSchema,
        eq(ProcessedEmailSchema.emailConnectionId, EmailConnectionSchema.id),
      )
      .where(
        and(
          eq(EmailConnectionSchema.userId, userId),
          eq(ProcessedEmailSchema.gmailMessageId, gmailMessageId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async markProcessed(data: ICreateProcessedEmail): Promise<IProcessedEmail | null> {
    const [row] = await this.db.client
      .insert(ProcessedEmailSchema)
      .values({
        emailConnectionId: data.emailConnectionId,
        gmailMessageId: data.gmailMessageId,
        outcome: data.outcome,
        transactionId: data.transactionId,
      })
      .onConflictDoNothing()
      .returning();
    return (row as IProcessedEmail) ?? null;
  }

  async getConnectionStats(connectionId: number): Promise<IConnectionStats> {
    const [scanned] = await this.db.client
      .select({ total: count() })
      .from(ProcessedEmailSchema)
      .where(eq(ProcessedEmailSchema.emailConnectionId, connectionId));

    const [extracted] = await this.db.client
      .select({ total: count() })
      .from(ProcessedEmailSchema)
      .where(
        and(
          eq(ProcessedEmailSchema.emailConnectionId, connectionId),
          eq(ProcessedEmailSchema.outcome, 'parsed'),
        ),
      );

    const [nonTx] = await this.db.client
      .select({ total: count() })
      .from(ProcessedEmailSchema)
      .where(
        and(
          eq(ProcessedEmailSchema.emailConnectionId, connectionId),
          eq(ProcessedEmailSchema.outcome, 'non_transaction'),
        ),
      );

    const [failed] = await this.db.client
      .select({ total: count() })
      .from(ProcessedEmailSchema)
      .where(
        and(
          eq(ProcessedEmailSchema.emailConnectionId, connectionId),
          eq(ProcessedEmailSchema.outcome, 'failed'),
        ),
      );

    // Regex = transaction was created via a parser template (parserTemplateId set)
    const [byRegex] = await this.db.client
      .select({ total: count() })
      .from(TransactionSchema)
      .where(
        and(
          eq(TransactionSchema.emailConnectionId, connectionId),
          isNotNull(TransactionSchema.parserTemplateId),
        ),
      );

    const [byAi] = await this.db.client
      .select({ total: count() })
      .from(TransactionSchema)
      .where(eq(TransactionSchema.emailConnectionId, connectionId));

    const totalTx = Number(byAi?.total ?? 0);
    const regexCount = Number(byRegex?.total ?? 0);

    return {
      emailsScanned: Number(scanned?.total ?? 0),
      transactionsExtracted: Number(extracted?.total ?? 0),
      nonTransactions: Number(nonTx?.total ?? 0),
      failed: Number(failed?.total ?? 0),
      byRegex: regexCount,
      byAi: totalTx - regexCount,
    };
  }

  async deleteConnectionData(connectionId: number): Promise<void> {
    await this.db.client
      .delete(TransactionSchema)
      .where(eq(TransactionSchema.emailConnectionId, connectionId));

    await this.db.client
      .delete(ProcessedEmailSchema)
      .where(eq(ProcessedEmailSchema.emailConnectionId, connectionId));
  }
}

export default IngestionRepositoryImpl;
