import { inject, injectable } from 'tsyringe';
import { and, eq, isNull } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { AccountSchema } from './account.schema';
import { IAccount } from './account.interface';

export interface IAccountRepository {
  findMatch(userId: number, bankId: number | null, currency: string, mask?: string | null): Promise<IAccount | null>;
  create(data: {
    userId: number;
    bankId: number | null;
    currency: string;
    label: string;
    accountNumberMask?: string | null;
  }): Promise<IAccount>;
  findAllByUser(userId: number): Promise<IAccount[]>;
  findById(id: number, userId: number): Promise<IAccount | null>;
  update(id: number, userId: number, data: { label?: string; isActive?: boolean }): Promise<IAccount>;
}

@injectable()
class AccountRepositoryImpl implements IAccountRepository {
  constructor(@inject(Database) private db: Database) {}

  async findMatch(userId: number, bankId: number | null, currency: string, mask?: string | null): Promise<IAccount | null> {
    const rows = await this.db.client
      .select()
      .from(AccountSchema)
      .where(
        and(
          eq(AccountSchema.userId, userId),
          bankId === null ? isNull(AccountSchema.bankId) : eq(AccountSchema.bankId, bankId),
          eq(AccountSchema.currency, currency),
          // Same (bank, currency) alone isn't enough to call it the same
          // account once a mask is in the picture: two accounts at the same
          // bank in the same currency (checking vs. savings) are
          // distinguished by account number. When the caller supplies one,
          // require an exact match rather than treating an existing
          // unset-mask record as a wildcard, otherwise the first account
          // created without a number would silently absorb every later one
          // created with a different number at the same (bank, currency).
          mask ? eq(AccountSchema.accountNumberMask, mask) : undefined,
        ),
      )
      .limit(1);
    return (rows[0] as IAccount) ?? null;
  }

  async create(data: {
    userId: number;
    bankId: number | null;
    currency: string;
    label: string;
    accountNumberMask?: string | null;
  }): Promise<IAccount> {
    const created = await this.db.client
      .insert(AccountSchema)
      .values({
        userId: data.userId,
        bankId: data.bankId,
        currency: data.currency,
        label: data.label,
        accountNumberMask: data.accountNumberMask ?? null,
      })
      .returning();
    return created[0] as IAccount;
  }

  async findAllByUser(userId: number): Promise<IAccount[]> {
    return (await this.db.client
      .select()
      .from(AccountSchema)
      .where(and(eq(AccountSchema.userId, userId), eq(AccountSchema.isActive, true)))
      .orderBy(AccountSchema.createdAt)) as IAccount[];
  }

  async findById(id: number, userId: number): Promise<IAccount | null> {
    const rows = await this.db.client
      .select()
      .from(AccountSchema)
      .where(and(eq(AccountSchema.id, id), eq(AccountSchema.userId, userId)))
      .limit(1);
    return (rows[0] as IAccount) ?? null;
  }

  async update(id: number, userId: number, data: { label?: string; isActive?: boolean }): Promise<IAccount> {
    const updated = await this.db.client
      .update(AccountSchema)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(AccountSchema.id, id), eq(AccountSchema.userId, userId)))
      .returning();
    return updated[0] as IAccount;
  }
}

export default AccountRepositoryImpl;
