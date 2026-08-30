import express from 'express';
import { container } from 'tsyringe';
import cron from 'node-cron';
import InsightController from './insight.controller';
import InsightService from './insight.service';
import InsightRepositoryImpl from './insight.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import { IUserRepository } from '@/modules/user/user.repository';
import logger from '@/common/lib/logger';

export async function registerInsightDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.INSIGHT, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IInsightRepository', InsightRepositoryImpl);
  container.registerSingleton<InsightService>(InsightService);
  container.registerSingleton<InsightController>(InsightController);

  cron.schedule('30 2 * * 1', async () => {
    const service = container.resolve(InsightService);
    const userRepository = container.resolve<IUserRepository>('IUserRepository');
    const users = await userRepository.findAll();
    await Promise.all(users.map((u) => service.generateWeeklyReportForUser(u.id)));
  });

  cron.schedule('0 3 1 * *', async () => {
    const service = container.resolve(InsightService);
    const userRepository = container.resolve<IUserRepository>('IUserRepository');
    const users = await userRepository.findAll();
    await Promise.all(users.map((u) => service.generateMonthlyReportForUser(u.id)));
  });

  logger.info('InsightGenerationScheduler started (weekly Mondays at 2:30 AM, monthly on the 1st at 3:00 AM).');
}
