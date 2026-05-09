import { inject, injectable } from 'tsyringe';
import { and, between, count, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { TransactionSchema } from './transaction.schema';
import { ITransaction, ICreateTransaction, ITransactionFilter } from './transaction.interface';
import { TransactionStatusEnum } from './transaction.enum';
import { IPagination } from '@/common/types/interface';

export interface ITransactionRepository {
  create(data: ICreateTransaction): Promise<ITransaction>;
  findById(id: number, userId: number): Promise<ITransaction | null>;
  findAll(filter: ITransactionFilter): Promise<IPagination<ITransaction>>;
  findUnverified(userId: number): Promise<ITransaction[]>;
  update(id: number, userId: number, data: Partial<ITransaction>): Promise<ITransaction>;
  delete(id: number, userId: number): Promise<void>;
  deleteOlderThan(userId: number, cutoffDate: Date): Promise<void>;
  findForSummary(userId: number, from: Date, to: Date): Promise<ITransaction[]>;
}

@injectable()
class TransactionRepositoryImpl implements ITransactionRepository {
  constructor(@inject(Database) private db: Database) {}

  async create(data: ICreateTransaction): Promise<ITransaction> {
    const [row] = await this.db.client
      .insert(TransactionSchema)
      .values({
        userId: data.userId,
        emailConnectionId: data.emailConnectionId,
        bankId: data.bankId,
        parserTemplateId: data.parserTemplateId,
        gmailMessageId: data.gmailMessageId,
        merchant: data.merchant,
        category: data.category,
        transactionType: data.transactionType,
        amount: data.amount,
        currency: data.currency,
        refAmount: data.refAmount,
        refCurrency: data.refCurrency,
        exchangeRateUsed: data.exchangeRateUsed,
        transactionDate: data.transactionDate,
        status: data.status,
        originalMerchant: data.merchant,
        originalCategory: data.category,
        reference: data.reference,
        balance: data.balance,
      })
      .returning();
    return row as ITransaction;
  }

  async findById(id: number, userId: number): Promise<ITransaction | null> {
    const rows = await this.db.client
      .select()
      .from(TransactionSchema)
      .where(and(eq(TransactionSchema.id, id), eq(TransactionSchema.userId, userId)))
      .limit(1);
    return (rows[0] as ITransaction) ?? null;
  }

  async findAll(filter: ITransactionFilter): Promise<IPagination<ITransaction>> {
    const conditions = [eq(TransactionSchema.userId, filter.userId)];

    if (filter.category) conditions.push(eq(TransactionSchema.category, filter.category));
    if (filter.currency) conditions.push(eq(TransactionSchema.currency, filter.currency));
    if (filter.bankId) conditions.push(eq(TransactionSchema.bankId, filter.bankId));
    if (filter.status) conditions.push(eq(TransactionSchema.status, filter.status));
    if (filter.dateFrom) conditions.push(gte(TransactionSchema.transactionDate, filter.dateFrom));
    if (filter.dateTo) conditions.push(lte(TransactionSchema.transactionDate, filter.dateTo));
    if (filter.search) conditions.push(ilike(TransactionSchema.merchant, `%${filter.search}%`));

    const whereClause = and(...conditions);
    const offset = (filter.page - 1) * filter.limit;

    const [totalResult] = await this.db.client
      .select({ count: count() })
      .from(TransactionSchema)
      .where(whereClause);

    const totalItems = Number(totalResult.count);

    const items = (await this.db.client
      .select()
      .from(TransactionSchema)
      .where(whereClause)
      .limit(filter.limit)
      .offset(offset)
      .orderBy(sql`${TransactionSchema.transactionDate} desc`)) as ITransaction[];

    return {
      page: filter.page,
      limit: filter.limit,
      total_items: totalItems,
      pages: Math.ceil(totalItems / filter.limit),
      items,
    };
  }

  async findUnverified(userId: number): Promise<ITransaction[]> {
    return (await this.db.client
      .select()
      .from(TransactionSchema)
      .where(
        and(
          eq(TransactionSchema.userId, userId),
          or(
            eq(TransactionSchema.status, TransactionStatusEnum.UNVERIFIED),
            eq(TransactionSchema.status, TransactionStatusEnum.REVIEW),
          ),
        ),
      )
      .orderBy(sql`${TransactionSchema.transactionDate} desc`)) as ITransaction[];
  }

  async update(id: number, userId: number, data: Partial<ITransaction>): Promise<ITransaction> {
    const [row] = await this.db.client
      .update(TransactionSchema)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(TransactionSchema.id, id), eq(TransactionSchema.userId, userId)))
      .returning();
    return row as ITransaction;
  }

  async delete(id: number, userId: number): Promise<void> {
    await this.db.client
      .delete(TransactionSchema)
      .where(and(eq(TransactionSchema.id, id), eq(TransactionSchema.userId, userId)));
  }

  async deleteOlderThan(userId: number, cutoffDate: Date): Promise<void> {
    await this.db.client
      .delete(TransactionSchema)
      .where(
        and(
          eq(TransactionSchema.userId, userId),
          lte(TransactionSchema.transactionDate, cutoffDate),
        ),
      );
  }

  async findForSummary(userId: number, from: Date, to: Date): Promise<ITransaction[]> {
    return (await this.db.client
      .select()
      .from(TransactionSchema)
      .where(
        and(
          eq(TransactionSchema.userId, userId),
          gte(TransactionSchema.transactionDate, from),
          lte(TransactionSchema.transactionDate, to),
        ),
      )) as ITransaction[];
  }
}

export default TransactionRepositoryImpl;
