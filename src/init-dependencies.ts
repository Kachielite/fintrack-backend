import 'reflect-metadata';
import express from 'express';
import { container } from 'tsyringe';
import cron from 'node-cron';
import Database from '@/common/lib/database';
import { APP_TOKENS } from '@/common/constants/app.tokens';
import { CONSTANTS } from '@/common/configuration/constants';

import { registerAuthDependencies } from '@/modules/auth/auth.dependencies';
import { registerUserDependencies } from '@/modules/user/user.dependencies';
import { registerEmailConnectionDependencies } from '@/modules/email-connection/email-connection.dependencies';
import { registerBankDependencies } from '@/modules/bank/bank.dependencies';
import { registerAccountDependencies } from '@/modules/account/account.dependencies';
import { registerParserRuleDependencies } from '@/modules/parser-rule/parser-rule.dependencies';
import { registerIngestionDependencies } from '@/modules/ingestion/ingestion.dependencies';
import { registerTransactionDependencies } from '@/modules/transaction/transaction.dependencies';
import { registerExchangeRateDependencies } from '@/modules/exchange-rate/exchange-rate.dependencies';
import { registerBudgetDependencies } from '@/modules/budget/budget.dependencies';
import { registerGoalDependencies } from '@/modules/goal/goal.dependencies';
import { registerInsightDependencies } from '@/modules/insight/insight.dependencies';
import { registerAdminDependencies } from '@/modules/admin/admin.dependencies';
import { registerNotificationDependencies } from '@/modules/notification/notification.dependencies';
import { registerCategoryDependencies } from '@/modules/category/category.dependencies';
import { registerIrisDependencies } from '@/modules/iris/iris.dependencies';

import AuthController from '@/modules/auth/auth.controller';
import UserController from '@/modules/user/user.controller';
import EmailConnectionController from '@/modules/email-connection/email-connection.controller';
import BankController from '@/modules/bank/bank.controller';
import AccountController from '@/modules/account/account.controller';
import ParserRuleController from '@/modules/parser-rule/parser-rule.controller';
import TransactionController from '@/modules/transaction/transaction.controller';
import ExchangeRateController from '@/modules/exchange-rate/exchange-rate.controller';
import BudgetController from '@/modules/budget/budget.controller';
import GoalController from '@/modules/goal/goal.controller';
import InsightController from '@/modules/insight/insight.controller';
import AdminController from '@/modules/admin/admin.controller';
import NotificationController from '@/modules/notification/notification.controller';
import CategoryController from '@/modules/category/category.controller';
import IrisController from '@/modules/iris/iris.controller';
import EmbeddingService from '@/modules/iris/embedding/embedding.service';
import IngestionService from '@/modules/ingestion/ingestion.service';
import { IUserRepository } from '@/modules/user/user.repository';
import logger from '@/common/lib/logger';

export async function configureContainer(): Promise<void> {
  container.registerSingleton<Database>(Database);
  const db = container.resolve(Database);
  const migrated = await db.migrate();
  if (migrated) logger.info('Database migrations applied successfully.');

  container.register(APP_TOKENS.EXPRESS_APP, {
    useFactory: () => express(),
  });

  await registerAuthDependencies();
  await registerUserDependencies();
  await registerEmailConnectionDependencies();
  await registerBankDependencies();
  await registerAccountDependencies(); // must come after bank
  await registerParserRuleDependencies();
  await registerNotificationDependencies(); // must come before ingestion
  await registerCategoryDependencies();
  await registerIngestionDependencies();
  await registerTransactionDependencies();
  await registerExchangeRateDependencies();
  await registerBudgetDependencies();
  await registerGoalDependencies();
  await registerInsightDependencies();
  await registerAdminDependencies();
  await registerIrisDependencies();

  // Resolve all controllers after every token is registered to trigger route wiring
  container.resolve(AuthController);
  container.resolve(UserController);
  container.resolve(EmailConnectionController);
  container.resolve(BankController);
  container.resolve(AccountController);
  container.resolve(ParserRuleController);
  container.resolve(TransactionController);
  container.resolve(ExchangeRateController);
  container.resolve(BudgetController);
  container.resolve(GoalController);
  container.resolve(InsightController);
  container.resolve(AdminController);
  container.resolve(NotificationController);
  container.resolve(CategoryController);
  container.resolve(IrisController);

  cron.schedule(`*/${CONSTANTS.GMAIL_POLL_INTERVAL_MINUTES} * * * *`, async () => {
    const ingestionService = container.resolve(IngestionService);
    await ingestionService.pollAllConnections();
  });
  logger.info(`GmailPollingScheduler started (every ${CONSTANTS.GMAIL_POLL_INTERVAL_MINUTES} minutes).`);

  cron.schedule('*/30 * * * *', async () => {
    const ingestionService = container.resolve(IngestionService);
    await ingestionService.sweepRetryableMessages();
  });
  logger.info('RetryableSweepScheduler started (every 30 minutes).');

  cron.schedule('45 2 * * *', async () => {
    const embeddingService = container.resolve(EmbeddingService);
    const userRepository = container.resolve<IUserRepository>('IUserRepository');
    const users = await userRepository.findAll();
    await Promise.all(users.map((u) => embeddingService.rebuildForUser(u.id)));
  });
  logger.info('IrisEmbeddingScheduler started (nightly at 2:45 AM).');
}
