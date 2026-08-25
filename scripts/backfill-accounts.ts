/**
 * BE-1.2 — one-time (but safely re-runnable) account backfill.
 *
 * Groups each user's existing transactions by (bank_id, currency) and
 * resolves/creates one account per group via AccountService — the same
 * resolve-or-create logic ingestion now uses live — then assigns that
 * account's id back onto every transaction in the group. Only touches
 * transactions where account_id is still null, so it's safe to re-run.
 *
 * Requires migrations up to 0010 (accounts/transfer_links) already applied.
 * Usage: npm run db:backfill-accounts
 */
import 'reflect-metadata';
import 'dotenv/config';
import { isNull, and, eq } from 'drizzle-orm';
import Database from '../src/common/lib/database';
import { TransactionSchema } from '../src/modules/transaction/transaction.schema';
import BankRepositoryImpl from '../src/modules/bank/bank.repository';
import AccountRepositoryImpl from '../src/modules/account/account.repository';
import AccountService from '../src/modules/account/account.service';
import TransactionRepositoryImpl from '../src/modules/transaction/transaction.repository';

async function backfill() {
  const db = new Database();
  const bankRepository = new BankRepositoryImpl(db);
  const accountRepository = new AccountRepositoryImpl(db);
  const transactionRepository = new TransactionRepositoryImpl(db);
  const accountService = new AccountService(accountRepository, bankRepository, transactionRepository);

  const groups = await db.client
    .selectDistinct({
      userId: TransactionSchema.userId,
      bankId: TransactionSchema.bankId,
      currency: TransactionSchema.currency,
    })
    .from(TransactionSchema)
    .where(isNull(TransactionSchema.accountId));

  console.log(`Found ${groups.length} (user, bank, currency) group(s) to backfill`);

  let transactionsUpdated = 0;

  for (const group of groups) {
    const account = await accountService.resolveOrCreate(group.userId, group.bankId, group.currency);

    const bankCondition = group.bankId === null ? isNull(TransactionSchema.bankId) : eq(TransactionSchema.bankId, group.bankId);

    const updated = await db.client
      .update(TransactionSchema)
      .set({ accountId: account.id })
      .where(
        and(
          eq(TransactionSchema.userId, group.userId),
          bankCondition,
          eq(TransactionSchema.currency, group.currency),
          isNull(TransactionSchema.accountId),
        ),
      )
      .returning({ id: TransactionSchema.id });

    transactionsUpdated += updated.length;
    console.log(
      `  user ${group.userId}, bank ${group.bankId ?? 'unknown'}, ${group.currency} -> account ${account.id} (${updated.length} transaction(s))`,
    );
  }

  const remaining = await db.client
    .select({ id: TransactionSchema.id, userId: TransactionSchema.userId })
    .from(TransactionSchema)
    .where(isNull(TransactionSchema.accountId));

  if (remaining.length > 0) {
    console.warn(
      `${remaining.length} transaction(s) still have no account_id after backfill: ${remaining.map((r) => r.id).join(', ')}`,
    );
  } else {
    console.log('Every transaction now has a non-null account_id.');
  }

  console.log(`Backfill complete: ${transactionsUpdated} transaction(s) updated across ${groups.length} group(s).`);
  await db.close();
}

backfill().catch((err) => {
  console.error(err);
  process.exit(1);
});
