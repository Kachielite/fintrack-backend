import express from 'express';
import { container } from 'tsyringe';
import TransactionController from './transaction.controller';
import TransactionService from './transaction.service';
import TransactionRepositoryImpl from './transaction.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';

export async function registerTransactionDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.TRANSACTION, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('ITransactionRepository', TransactionRepositoryImpl);
  container.registerSingleton<TransactionService>(TransactionService);
  container.registerSingleton<TransactionController>(TransactionController);

}
