import 'reflect-metadata';
import 'dotenv/config';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { google } from 'googleapis';
import Database from '@/common/lib/database';
import EmailConnectionRepositoryImpl from '@/modules/email-connection/email-connection.repository';
import IngestionRepositoryImpl from '@/modules/ingestion/ingestion.repository';
import BudgetRepositoryImpl from '@/modules/budget/budget.repository';
import InsightRepositoryImpl from '@/modules/insight/insight.repository';
import AccountRepositoryImpl from '@/modules/account/account.repository';
import BankRepositoryImpl from '@/modules/bank/bank.repository';
import TransactionRepositoryImpl from '@/modules/transaction/transaction.repository';
import UserRepositoryImpl from '@/modules/user/user.repository';
import AccountService from '@/modules/account/account.service';
import EmailConnectionService from '@/modules/email-connection/email-connection.service';
import { TransactionSchema } from '@/modules/transaction/transaction.schema';

// Repairs transactions from the September ingestion incident (fintrack-backend#158)
// whose transactionDate was silently defaulted to processing time (new Date())
// because no date could be found in the extracted text - identified by
// transaction_date falling on the exact same calendar day as created_at, which
// is the specific symptom of that fallback (a genuinely correct date almost
// never coincides with the moment the backend happened to process the email).
// See fintrack-backend#170.
//
// Usage:
//   ts-node -r tsconfig-paths/register scripts/repair-incident-transaction-dates.ts <connectionId>            (dry run)
//   ts-node -r tsconfig-paths/register scripts/repair-incident-transaction-dates.ts <connectionId> --apply    (writes)

const connectionIdArg = process.argv[2];
const apply = process.argv.includes('--apply');

if (!connectionIdArg || isNaN(Number(connectionIdArg))) {
  console.error('Usage: ts-node scripts/repair-incident-transaction-dates.ts <connectionId> [--apply]');
  process.exit(1);
}
const connectionId = Number(connectionIdArg);

async function main() {
  const db = new Database();
  const connectionRepository = new EmailConnectionRepositoryImpl(db);
  const ingestionRepository = new IngestionRepositoryImpl(db);
  const budgetRepository = new BudgetRepositoryImpl(db);
  const insightRepository = new InsightRepositoryImpl(db);
  const accountRepository = new AccountRepositoryImpl(db);
  const bankRepository = new BankRepositoryImpl(db);
  const transactionRepository = new TransactionRepositoryImpl(db);
  const userRepository = new UserRepositoryImpl(db);
  const accountService = new AccountService(accountRepository, bankRepository, transactionRepository);
  const emailConnectionService = new EmailConnectionService(
    connectionRepository,
    ingestionRepository,
    budgetRepository,
    insightRepository,
    accountService,
    userRepository,
  );

  try {
    const connection = await connectionRepository.findByIdOnly(connectionId);
    if (!connection) {
      console.error(`No connection found with id=${connectionId}`);
      process.exit(1);
    }
    console.log(`Repairing transaction dates for connection ${connectionId} (${connection.gmailAddress})`);
    console.log(apply ? 'Mode: APPLY (will write changes)' : 'Mode: DRY RUN (no changes will be written)');

    const candidates = await db.client
      .select({
        id: TransactionSchema.id,
        gmailMessageId: TransactionSchema.gmailMessageId,
        transactionDate: TransactionSchema.transactionDate,
        createdAt: TransactionSchema.createdAt,
        merchant: TransactionSchema.merchant,
      })
      .from(TransactionSchema)
      .where(
        and(
          eq(TransactionSchema.emailConnectionId, connectionId),
          isNotNull(TransactionSchema.gmailMessageId),
          sql`date_trunc('day', ${TransactionSchema.transactionDate}) = date_trunc('day', ${TransactionSchema.createdAt})`,
        ),
      );

    console.log(`Found ${candidates.length} candidate row(s)\n`);
    if (candidates.length === 0) {
      return;
    }

    const oauth2Client = await emailConnectionService.getOAuth2Client(connection);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    let repaired = 0;
    let skipped = 0;
    let unchanged = 0;

    for (const tx of candidates) {
      if (!tx.gmailMessageId) {
        skipped++;
        continue;
      }
      try {
        const msgResp = await gmail.users.messages.get({ userId: 'me', id: tx.gmailMessageId, format: 'minimal' });
        const internalDateMs = Number(msgResp.data.internalDate);
        if (!Number.isFinite(internalDateMs) || internalDateMs <= 0) {
          console.log(`  [skip] tx ${tx.id} (${tx.merchant}): message has no valid internalDate`);
          skipped++;
          continue;
        }
        const recoveredDate = new Date(internalDateMs);

        if (recoveredDate.toDateString() === new Date(tx.transactionDate).toDateString()) {
          // The real date happens to fall on the same day as created_at anyway
          // (e.g. the email genuinely arrived the same day it was processed) -
          // nothing to fix here.
          unchanged++;
          continue;
        }

        console.log(
          `  [${apply ? 'repair' : 'would repair'}] tx ${tx.id} (${tx.merchant}): ` +
            `${new Date(tx.transactionDate).toISOString()} -> ${recoveredDate.toISOString()}`,
        );
        if (apply) {
          await db.client
            .update(TransactionSchema)
            .set({ transactionDate: recoveredDate, updatedAt: new Date() })
            .where(eq(TransactionSchema.id, tx.id));
        }
        repaired++;
      } catch (err) {
        console.log(`  [skip] tx ${tx.id} (${tx.merchant}): failed to fetch message ${tx.gmailMessageId} - ${err}`);
        skipped++;
      }
    }

    console.log(
      `\nSummary: ${candidates.length} scanned, ${repaired} ${apply ? 'repaired' : 'would repair'}, ` +
        `${unchanged} already correct, ${skipped} skipped (message unavailable)`,
    );
    if (!apply && repaired > 0) {
      console.log('\nRun again with --apply to write these changes.');
    }
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
