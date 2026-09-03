import 'reflect-metadata';
import 'dotenv/config';
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

const GMAIL_ADDRESS = process.argv[2];
if (!GMAIL_ADDRESS) {
  console.error('Usage: ts-node scripts/delete-email-connection.ts <gmail_address>');
  process.exit(1);
}

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
    // findAllActive() isn't scoped to a user, so we can locate the connection by
    // gmail address directly without needing to already know the user id.
    const active = await connectionRepository.findAllActive();
    const match = active.find((c) => c.gmailAddress === GMAIL_ADDRESS);
    if (!match) {
      console.error(`No active connection found for ${GMAIL_ADDRESS}. (This script only searches active connections.)`);
      process.exit(1);
    }

    console.log(`Found connection id=${match.id} for user_id=${match.userId} (${GMAIL_ADDRESS})`);

    console.log('Deleting connection data (transactions, processed_emails, budgets, insights, orphaned accounts)...');
    const dataResult = await emailConnectionService.deleteConnectionData(match.id, match.userId);
    console.log('  ', dataResult.message);

    console.log('Deleting the connection itself (revokes Google token)...');
    const connResult = await emailConnectionService.deleteConnection(match.id, match.userId);
    console.log('  ', connResult.message);

    console.log('\nDone.');
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
