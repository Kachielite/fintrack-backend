import { inject, injectable } from 'tsyringe';
import { and, eq, isNull } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { AccountSchema } from './account.schema';
import { IAccount } from './account.interface';

export interface IAccountRepository {
  findMatch(userId: number, bankId: number | null, currency: string): Promise<IAccount | null>;
  create(data: {
    userId: number;
    bankId: number | null;
    currency: string;
    label: string;
    accountNumberMask?: string | null;
  }): Promise<IAccount>;
  setMask(id: number, mask: string): Promise<IAccount>;
  findAllByUser(userId: number): Promise<IAccount[]>;
  findById(id: number, userId: number): Promise<IAccount | null>;
  update(id: number, userId: number, data: { label?: string; isActive?: boolean }): Promise<IAccount>;
}

@injectable()
class AccountRepositoryImpl implements IAccountRepository {
  constructor(@inject(Database) private db: Database) {}

  async findMatch(userId: number, bankId: number | null, currency: string): Promise<IAccount | null> {
    const rows = await this.db.client
      .select()
      .from(AccountSchema)
      .where(
        and(
          eq(AccountSchema.userId, userId),
          bankId === null ? isNull(AccountSchema.bankId) : eq(AccountSchema.bankId, bankId),
          eq(AccountSchema.currency, currency),
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

  async setMask(id: number, mask: string): Promise<IAccount> {
    const updated = await this.db.client
      .update(AccountSchema)
      .set({ accountNumberMask: mask, updatedAt: new Date() })
      .where(eq(AccountSchema.id, id))
      .returning();
    return updated[0] as IAccount;
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
