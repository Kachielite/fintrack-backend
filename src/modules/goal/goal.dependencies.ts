import express from 'express';
import { container } from 'tsyringe';
import GoalController from './goal.controller';
import GoalService from './goal.service';
import GoalRepositoryImpl from './goal.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';

export async function registerGoalDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.GOAL, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IGoalRepository', GoalRepositoryImpl);
  container.registerSingleton<GoalService>(GoalService);
  container.registerSingleton<GoalController>(GoalController);

}
