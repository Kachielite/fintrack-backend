import express from 'express';
import { container } from 'tsyringe';
import BankController from './bank.controller';
import BankService from './bank.service';
import BankRepositoryImpl from './bank.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';

export async function registerBankDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.BANK, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IBankRepository', BankRepositoryImpl);
  container.registerSingleton<BankService>(BankService);
  container.registerSingleton<BankController>(BankController);

}
