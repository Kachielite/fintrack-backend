import { inject, injectable } from 'tsyringe';
import { and, between, count, desc, eq, gte, ilike, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { TransactionSchema } from './transaction.schema';
import { BankSchema } from '@/modules/bank/bank.schema';
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
  countByCategory(userId: number, category: string): Promise<number>;
  countByAccount(userId: number, accountId: number): Promise<number>;
  findAllForExport(userId: number): Promise<ITransaction[]>;
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
  findLearnedCategoryForMerchant(userId: number, merchant: string): Promise<string | null>;
  findSimilarByMerchant(userId: number, merchant: string, excludeCategory: string, excludeId: number): Promise<ITransaction[]>;
  bulkUpdateCategory(userId: number, ids: number[], category: string): Promise<number>;
  /**
   * Unlinked (not yet excluded), opposite-sign transactions on a different
   * account of the same user, within a time window — candidates for
   * transfer-detection matching. Currency/amount matching happens in the caller.
   */
  findTransferCandidates(input: {
    userId: number;
    excludeTransactionId: number;
    excludeAccountId: number;
    transactionType: string;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<ITransaction[]>;
  markExcludedFromTotals(ids: number[]): Promise<void>;
  markIncludedInTotals(ids: number[]): Promise<void>;
  /** Most recent balance the ingestion pipeline captured on this account, if any. */
  findLatestBalance(accountId: number): Promise<{ balance: number; transactionDate: Date } | null>;
  reassignAccount(userId: number, fromAccountId: number, toAccountId: number): Promise<number>;
  /** Account-attributed, not-yet-excluded transactions for a user, oldest first — rescan candidates. */
  findUnexcludedForUser(userId: number): Promise<ITransaction[]>;
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
        accountId: data.accountId,
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
        originalMerchant: data.originalMerchant ?? data.merchant,
        originalCategory: data.category,
        reference: data.reference,
        balance: data.balance,
      })
      .returning();
    return row as ITransaction;
  }

  async findById(id: number, userId: number): Promise<ITransaction | null> {
    const rows = await this.db.client
      .select({
        id: TransactionSchema.id,
        userId: TransactionSchema.userId,
        emailConnectionId: TransactionSchema.emailConnectionId,
        bankId: TransactionSchema.bankId,
        accountId: TransactionSchema.accountId,
        parserTemplateId: TransactionSchema.parserTemplateId,
        gmailMessageId: TransactionSchema.gmailMessageId,
        merchant: TransactionSchema.merchant,
        category: TransactionSchema.category,
        transactionType: TransactionSchema.transactionType,
        amount: TransactionSchema.amount,
        currency: TransactionSchema.currency,
        refAmount: TransactionSchema.refAmount,
        refCurrency: TransactionSchema.refCurrency,
        exchangeRateUsed: TransactionSchema.exchangeRateUsed,
        transactionDate: TransactionSchema.transactionDate,
        status: TransactionSchema.status,
        originalMerchant: TransactionSchema.originalMerchant,
        originalCategory: TransactionSchema.originalCategory,
        reference: TransactionSchema.reference,
        balance: TransactionSchema.balance,
        excludeFromTotals: TransactionSchema.excludeFromTotals,
        createdAt: TransactionSchema.createdAt,
        updatedAt: TransactionSchema.updatedAt,
        bankName: BankSchema.name,
        bankShortCode: BankSchema.shortCode,
        bankLogoUrl: BankSchema.logoUrl,
      })
      .from(TransactionSchema)
      .leftJoin(BankSchema, eq(TransactionSchema.bankId, BankSchema.id))
      .where(and(eq(TransactionSchema.id, id), eq(TransactionSchema.userId, userId)))
      .limit(1);
    return (rows[0] as ITransaction) ?? null;
  }

  async findAll(filter: ITransactionFilter): Promise<IPagination<ITransaction>> {
    const conditions = [eq(TransactionSchema.userId, filter.userId)];

    if (filter.category?.length) conditions.push(inArray(TransactionSchema.category, filter.category));
    if (filter.currency?.length) conditions.push(inArray(TransactionSchema.currency, filter.currency));
    if (filter.bankId?.length) conditions.push(inArray(TransactionSchema.bankId, filter.bankId));
    if (filter.accountId?.length) conditions.push(inArray(TransactionSchema.accountId, filter.accountId));
    if (filter.status) conditions.push(eq(TransactionSchema.status, filter.status));
    if (filter.dateFrom) conditions.push(gte(TransactionSchema.transactionDate, filter.dateFrom));
    if (filter.dateTo) conditions.push(lte(TransactionSchema.transactionDate, filter.dateTo));
    if (filter.search) conditions.push(ilike(TransactionSchema.merchant, `%${filter.search}%`));
    if (filter.excludeFromTotals !== undefined)
      conditions.push(eq(TransactionSchema.excludeFromTotals, filter.excludeFromTotals));

    const whereClause = and(...conditions);
    const offset = (filter.page - 1) * filter.limit;

    const [totalResult] = await this.db.client
      .select({ count: count() })
      .from(TransactionSchema)
      .where(whereClause);

    const totalItems = Number(totalResult.count);

    const items = (await this.db.client
      .select({
        id: TransactionSchema.id,
        userId: TransactionSchema.userId,
        emailConnectionId: TransactionSchema.emailConnectionId,
        bankId: TransactionSchema.bankId,
        accountId: TransactionSchema.accountId,
        parserTemplateId: TransactionSchema.parserTemplateId,
        gmailMessageId: TransactionSchema.gmailMessageId,
        merchant: TransactionSchema.merchant,
        category: TransactionSchema.category,
        transactionType: TransactionSchema.transactionType,
        amount: TransactionSchema.amount,
        currency: TransactionSchema.currency,
        refAmount: TransactionSchema.refAmount,
        refCurrency: TransactionSchema.refCurrency,
        exchangeRateUsed: TransactionSchema.exchangeRateUsed,
        transactionDate: TransactionSchema.transactionDate,
        status: TransactionSchema.status,
        originalMerchant: TransactionSchema.originalMerchant,
        originalCategory: TransactionSchema.originalCategory,
        reference: TransactionSchema.reference,
        balance: TransactionSchema.balance,
        excludeFromTotals: TransactionSchema.excludeFromTotals,
        createdAt: TransactionSchema.createdAt,
        updatedAt: TransactionSchema.updatedAt,
        bankName: BankSchema.name,
        bankShortCode: BankSchema.shortCode,
        bankLogoUrl: BankSchema.logoUrl,
      })
      .from(TransactionSchema)
      .leftJoin(BankSchema, eq(TransactionSchema.bankId, BankSchema.id))
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

  async countByCategory(userId: number, category: string): Promise<number> {
    const [row] = await this.db.client
      .select({ count: count() })
      .from(TransactionSchema)
      .where(and(eq(TransactionSchema.userId, userId), eq(TransactionSchema.category, category)));
    return Number(row?.count ?? 0);
  }

  async countByAccount(userId: number, accountId: number): Promise<number> {
    const [row] = await this.db.client
      .select({ count: count() })
      .from(TransactionSchema)
      .where(and(eq(TransactionSchema.userId, userId), eq(TransactionSchema.accountId, accountId)));
    return Number(row?.count ?? 0);
  }

  // Full history, no excludeFromTotals filter — export is about giving the
  // user everything they have, not just what counts toward totals.
  async findAllForExport(userId: number): Promise<ITransaction[]> {
    return (await this.db.client
      .select()
      .from(TransactionSchema)
      .where(eq(TransactionSchema.userId, userId))
      .orderBy(TransactionSchema.transactionDate)) as ITransaction[];
  }

  async findForSummary(userId: number, from: Date, to: Date): Promise<ITransaction[]> {
    // Every spend/income aggregation point (summary, charts, budgets, insights, Iris)
    // reads through here, so excluding transfer/conversion legs once at the source
    // keeps all of them correct without duplicating the filter at each call site.
    return (await this.db.client
      .select()
      .from(TransactionSchema)
      .where(
        and(
          eq(TransactionSchema.userId, userId),
          gte(TransactionSchema.transactionDate, from),
          lte(TransactionSchema.transactionDate, to),
          eq(TransactionSchema.excludeFromTotals, false),
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

  async bulkUpdateCategory(userId: number, ids: number[], category: string): Promise<number> {
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

  async findTransferCandidates(input: {
    userId: number;
    excludeTransactionId: number;
    excludeAccountId: number;
    transactionType: string;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<ITransaction[]> {
    return (await this.db.client
      .select()
      .from(TransactionSchema)
      .where(
        and(
          eq(TransactionSchema.userId, input.userId),
          eq(TransactionSchema.transactionType, input.transactionType),
          eq(TransactionSchema.excludeFromTotals, false),
          isNotNull(TransactionSchema.accountId),
          ne(TransactionSchema.accountId, input.excludeAccountId),
          ne(TransactionSchema.id, input.excludeTransactionId),
          between(TransactionSchema.transactionDate, input.windowStart, input.windowEnd),
        ),
      )
      .orderBy(TransactionSchema.transactionDate)) as ITransaction[];
  }

  async markExcludedFromTotals(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.client
      .update(TransactionSchema)
      .set({ excludeFromTotals: true, updatedAt: new Date() })
      .where(inArray(TransactionSchema.id, ids));
  }

  async markIncludedInTotals(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.client
      .update(TransactionSchema)
      .set({ excludeFromTotals: false, updatedAt: new Date() })
      .where(inArray(TransactionSchema.id, ids));
  }

  async findLatestBalance(accountId: number): Promise<{ balance: number; transactionDate: Date } | null> {
    const rows = await this.db.client
      .select({ balance: TransactionSchema.balance, transactionDate: TransactionSchema.transactionDate })
      .from(TransactionSchema)
      .where(and(eq(TransactionSchema.accountId, accountId), isNotNull(TransactionSchema.balance)))
      .orderBy(desc(TransactionSchema.transactionDate))
      .limit(1);
    const row = rows[0];
    if (!row || row.balance == null) return null;
    return { balance: row.balance, transactionDate: row.transactionDate };
  }

  async reassignAccount(userId: number, fromAccountId: number, toAccountId: number): Promise<number> {
    const result = await this.db.client
      .update(TransactionSchema)
      .set({ accountId: toAccountId, updatedAt: new Date() })
      .where(and(eq(TransactionSchema.userId, userId), eq(TransactionSchema.accountId, fromAccountId)))
      .returning({ id: TransactionSchema.id });
    return result.length;
  }

  async findUnexcludedForUser(userId: number): Promise<ITransaction[]> {
    return (await this.db.client
      .select()
      .from(TransactionSchema)
      .where(
        and(
          eq(TransactionSchema.userId, userId),
          eq(TransactionSchema.excludeFromTotals, false),
          isNotNull(TransactionSchema.accountId),
        ),
      )
      .orderBy(TransactionSchema.transactionDate)) as ITransaction[];
  }

  async findLearnedCategoryForMerchant(userId: number, merchant: string): Promise<string | null> {
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

    return rows[0]?.category ?? null;
  }
}

export default TransactionRepositoryImpl;
