import { inject, injectable } from 'tsyringe';
import { and, eq } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { ProcessedEmailSchema } from './ingestion.schema';
import { IProcessedEmail, ICreateProcessedEmail } from './ingestion.interface';

export interface IIngestionRepository {
  isAlreadyProcessed(connectionId: number, gmailMessageId: string): Promise<boolean>;
  markProcessed(data: ICreateProcessedEmail): Promise<IProcessedEmail>;
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

  async markProcessed(data: ICreateProcessedEmail): Promise<IProcessedEmail> {
    const [row] = await this.db.client
      .insert(ProcessedEmailSchema)
      .values({
        emailConnectionId: data.emailConnectionId,
        gmailMessageId: data.gmailMessageId,
        outcome: data.outcome,
        transactionId: data.transactionId,
      })
      .returning();
    return row as IProcessedEmail;
  }
}

export default IngestionRepositoryImpl;
