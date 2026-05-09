import express from 'express';
import { container } from 'tsyringe';
import BudgetController from './budget.controller';
import BudgetService from './budget.service';
import BudgetRepositoryImpl from './budget.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';

export async function registerBudgetDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.BUDGET, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IBudgetRepository', BudgetRepositoryImpl);
  container.registerSingleton<BudgetService>(BudgetService);
  container.registerSingleton<BudgetController>(BudgetController);

}
