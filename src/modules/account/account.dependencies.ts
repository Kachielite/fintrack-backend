import express from 'express';
import { container } from 'tsyringe';
import AccountService from './account.service';
import AccountRepositoryImpl from './account.repository';
import TransferLinkRepositoryImpl from './transfer-link.repository';
import TransferDetectionService from './transfer-detection.service';
import AccountTransferRuleRepositoryImpl from './account-transfer-rule.repository';
import AccountController from './account.controller';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';

export async function registerAccountDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.ACCOUNT, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IAccountRepository', AccountRepositoryImpl);
  container.registerSingleton<AccountService>(AccountService);
  container.registerSingleton('ITransferLinkRepository', TransferLinkRepositoryImpl);
  container.registerSingleton('IAccountTransferRuleRepository', AccountTransferRuleRepositoryImpl);
  container.registerSingleton<TransferDetectionService>(TransferDetectionService);
  container.registerSingleton<AccountController>(AccountController);
}
