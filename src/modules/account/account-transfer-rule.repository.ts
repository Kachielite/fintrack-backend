import { inject, injectable } from 'tsyringe';
import { and, eq } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { AccountTransferRuleSchema } from './account-transfer-rule.schema';
import { IAccountTransferRule, TransferRuleDecision } from './account-transfer-rule.interface';

export interface IAccountTransferRuleRepository {
  findForPair(userId: number, accountAId: number, accountBId: number): Promise<IAccountTransferRule | null>;
  upsert(
    userId: number,
    accountAId: number,
    accountBId: number,
    decision: TransferRuleDecision,
  ): Promise<IAccountTransferRule>;
}

@injectable()
class AccountTransferRuleRepositoryImpl implements IAccountTransferRuleRepository {
  constructor(@inject(Database) private db: Database) {}

  async findForPair(userId: number, accountAId: number, accountBId: number): Promise<IAccountTransferRule | null> {
    const [lo, hi] = accountAId < accountBId ? [accountAId, accountBId] : [accountBId, accountAId];
    const rows = await this.db.client
      .select()
      .from(AccountTransferRuleSchema)
      .where(
        and(
          eq(AccountTransferRuleSchema.userId, userId),
          eq(AccountTransferRuleSchema.accountAId, lo),
          eq(AccountTransferRuleSchema.accountBId, hi),
        ),
      )
      .limit(1);
    return (rows[0] as IAccountTransferRule) ?? null;
  }

  async upsert(
    userId: number,
    accountAId: number,
    accountBId: number,
    decision: TransferRuleDecision,
  ): Promise<IAccountTransferRule> {
    const [lo, hi] = accountAId < accountBId ? [accountAId, accountBId] : [accountBId, accountAId];
    const existing = await this.findForPair(userId, lo, hi);

    if (existing) {
      const [row] = await this.db.client
        .update(AccountTransferRuleSchema)
        .set({ decision, updatedAt: new Date() })
        .where(eq(AccountTransferRuleSchema.id, existing.id))
        .returning();
      return row as IAccountTransferRule;
    }

    const [row] = await this.db.client
      .insert(AccountTransferRuleSchema)
      .values({ userId, accountAId: lo, accountBId: hi, decision })
      .returning();
    return row as IAccountTransferRule;
  }
}

export default AccountTransferRuleRepositoryImpl;
