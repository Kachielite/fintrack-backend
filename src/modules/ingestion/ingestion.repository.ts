import { inject, injectable } from 'tsyringe';
import { and, count, eq, isNotNull, sql } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { ProcessedEmailSchema } from './ingestion.schema';
import { EmailConnectionSchema } from '@/modules/email-connection/email-connection.schema';
import { TransactionSchema } from '@/modules/transaction/transaction.schema';
import { IProcessedEmail, ICreateProcessedEmail, IConnectionStats } from './ingestion.interface';

// A retryable failure (e.g. rate-limited) stays retryable across poll cycles up to
// this many attempts, after which it's treated as terminal like any other
// processed message — this caps retries instead of looping on a message forever.
export const MAX_PROCESSING_RETRIES = 5;

export interface IIngestionRepository {
  isAlreadyProcessed(connectionId: number, gmailMessageId: string): Promise<boolean>;
  isAlreadyProcessedForUser(userId: number, gmailMessageId: string): Promise<boolean>;
  markProcessed(data: ICreateProcessedEmail): Promise<IProcessedEmail | null>;
  /**
   * Records a retryable failure (e.g. rate-limited extraction) without permanently
   * excluding the message — isAlreadyProcessed/isAlreadyProcessedForUser treat this
   * as "not yet processed" until retryCount reaches MAX_PROCESSING_RETRIES, so a
   * later poll cycle picks the message back up naturally.
   */
  markRetryable(connectionId: number, gmailMessageId: string): Promise<void>;
  getConnectionStats(connectionId: number): Promise<IConnectionStats>;
  deleteConnectionData(connectionId: number): Promise<void>;
}

@injectable()
class IngestionRepositoryImpl implements IIngestionRepository {
  constructor(@inject(Database) private db: Database) {}

  async isAlreadyProcessed(connectionId: number, gmailMessageId: string): Promise<boolean> {
    const rows = await this.db.client
      .select({ outcome: ProcessedEmailSchema.outcome, retryCount: ProcessedEmailSchema.retryCount })
      .from(ProcessedEmailSchema)
      .where(
        and(
          eq(ProcessedEmailSchema.emailConnectionId, connectionId),
          eq(ProcessedEmailSchema.gmailMessageId, gmailMessageId),
        ),
      )
      .limit(1);
    if (rows.length === 0) return false;
    const [row] = rows;
    if (row.outcome === 'failed') return row.retryCount >= MAX_PROCESSING_RETRIES;
    return true;
  }

  async isAlreadyProcessedForUser(userId: number, gmailMessageId: string): Promise<boolean> {
    const rows = await this.db.client
      .select({ outcome: ProcessedEmailSchema.outcome, retryCount: ProcessedEmailSchema.retryCount })
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
    if (rows.length === 0) return false;
    const [row] = rows;
    if (row.outcome === 'failed') return row.retryCount >= MAX_PROCESSING_RETRIES;
    return true;
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
      .onConflictDoUpdate({
        target: [ProcessedEmailSchema.emailConnectionId, ProcessedEmailSchema.gmailMessageId],
        set: {
          outcome: data.outcome,
          transactionId: data.transactionId,
          processedAt: new Date(),
        },
      })
      .returning();
    return (row as IProcessedEmail) ?? null;
  }

  async markRetryable(connectionId: number, gmailMessageId: string): Promise<void> {
    await this.db.client
      .insert(ProcessedEmailSchema)
      .values({
        emailConnectionId: connectionId,
        gmailMessageId,
        outcome: 'failed',
        // Counts this call itself as attempt 1, so retryCount reaching
        // MAX_PROCESSING_RETRIES means exactly that many attempts were made —
        // not that many again on top of an uncounted first one.
        retryCount: 1,
      })
      .onConflictDoUpdate({
        target: [ProcessedEmailSchema.emailConnectionId, ProcessedEmailSchema.gmailMessageId],
        set: {
          outcome: 'failed',
          retryCount: sql`${ProcessedEmailSchema.retryCount} + 1`,
          processedAt: new Date(),
        },
      });
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
