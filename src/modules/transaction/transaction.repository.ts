import { inject, injectable } from 'tsyringe';
import { and, between, count, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { TransactionSchema } from './transaction.schema';
import { ITransaction, ICreateTransaction, ITransactionFilter } from './transaction.interface';
import { CategoryEnum, TransactionStatusEnum } from './transaction.enum';
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
  existsSimilarTransaction(input: {
    userId: number;
    bankId?: number;
    currency: string;
    amountAbs: number;
    transactionType: string;
    reference?: string;
    merchant: string;
    transactionDate: Date;
  }): Promise<boolean>;
  findLearnedCategoryForMerchant(userId: number, merchant: string): Promise<CategoryEnum | null>;
  findSimilarByMerchant(userId: number, merchant: string, excludeCategory: string, excludeId: number): Promise<ITransaction[]>;
  bulkUpdateCategory(userId: number, ids: number[], category: CategoryEnum): Promise<number>;
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

  async existsSimilarTransaction(input: {
    userId: number;
    bankId?: number;
    currency: string;
    amountAbs: number;
    transactionType: string;
    reference?: string;
    merchant: string;
    transactionDate: Date;
  }): Promise<boolean> {
    const normalizedReference = input.reference?.trim();

    // Reference-based dedup is the strongest signal and should not depend on merchant parsing quality.
    if (normalizedReference) {
      const conditions = [
        eq(TransactionSchema.userId, input.userId),
        eq(TransactionSchema.currency, input.currency),
        eq(TransactionSchema.reference, normalizedReference),
        eq(TransactionSchema.transactionType, input.transactionType),
        between(sql`abs(${TransactionSchema.amount})`, input.amountAbs - 0.01, input.amountAbs + 0.01),
      ];
      if (input.bankId) conditions.push(eq(TransactionSchema.bankId, input.bankId));

      const rows = await this.db.client
        .select({ id: TransactionSchema.id })
        .from(TransactionSchema)
        .where(and(...conditions))
        .limit(1);

      return rows.length > 0;
    }

    // For transactions with no reference, use a narrow time-series fingerprint to avoid duplicates.
    const from = new Date(input.transactionDate.getTime() - 15 * 60 * 1000);
    const to = new Date(input.transactionDate.getTime() + 15 * 60 * 1000);
    const conditions = [
      eq(TransactionSchema.userId, input.userId),
      eq(TransactionSchema.currency, input.currency),
      eq(TransactionSchema.transactionType, input.transactionType),
      between(sql`abs(${TransactionSchema.amount})`, input.amountAbs - 0.01, input.amountAbs + 0.01),
      gte(TransactionSchema.transactionDate, from),
      lte(TransactionSchema.transactionDate, to),
    ];

    if (input.bankId) conditions.push(eq(TransactionSchema.bankId, input.bankId));

    const rows = await this.db.client
      .select({ id: TransactionSchema.id })
      .from(TransactionSchema)
      .where(and(...conditions))
      .limit(1);

    return rows.length > 0;
  }

  async findSimilarByMerchant(
    userId: number,
    merchant: string,
    excludeCategory: string,
    excludeId: number,
  ): Promise<ITransaction[]> {
    const normalizedMerchant = merchant.trim().toLowerCase();
    if (!normalizedMerchant) return [];

    return (await this.db.client
      .select()
      .from(TransactionSchema)
      .where(
        and(
          eq(TransactionSchema.userId, userId),
          ilike(TransactionSchema.merchant, normalizedMerchant),
          sql`${TransactionSchema.category} != ${excludeCategory}`,
          sql`${TransactionSchema.id} != ${excludeId}`,
        ),
      )
      .orderBy(sql`${TransactionSchema.transactionDate} desc`)
      .limit(50)) as ITransaction[];
  }

  async bulkUpdateCategory(userId: number, ids: number[], category: CategoryEnum): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db.client
      .update(TransactionSchema)
      .set({ category, status: TransactionStatusEnum.CORRECTED, updatedAt: new Date() })
      .where(
        and(
          eq(TransactionSchema.userId, userId),
          inArray(TransactionSchema.id, ids),
        ),
      )
      .returning({ id: TransactionSchema.id });
    return result.length;
  }

  async findLearnedCategoryForMerchant(
    userId: number,
    merchant: string,
  ): Promise<CategoryEnum | null> {
    const normalizedMerchant = merchant.trim().toLowerCase();
    if (!normalizedMerchant) return null;

    const rows = await this.db.client
      .select({ category: TransactionSchema.category })
      .from(TransactionSchema)
      .where(
        and(
          eq(TransactionSchema.userId, userId),
          eq(TransactionSchema.status, TransactionStatusEnum.CORRECTED),
          ilike(TransactionSchema.merchant, normalizedMerchant),
          sql`${TransactionSchema.originalCategory} is distinct from ${TransactionSchema.category}`,
        ),
      )
      .orderBy(sql`${TransactionSchema.updatedAt} desc`)
      .limit(1);

    const category = rows[0]?.category;
    if (category && Object.values(CategoryEnum).includes(category as CategoryEnum)) {
      return category as CategoryEnum;
    }
    return null;
  }
}

export default TransactionRepositoryImpl;
