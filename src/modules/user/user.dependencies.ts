import express from 'express';
import { container } from 'tsyringe';
import cron from 'node-cron';
import UserController from './user.controller';
import UserService from './user.service';
import UserRepositoryImpl from './user.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import logger from '@/common/lib/logger';

export async function registerUserDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.USER, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IUserRepository', UserRepositoryImpl);
  container.registerSingleton<UserService>(UserService);
  container.registerSingleton<UserController>(UserController);

  cron.schedule('0 4 * * *', async () => {
    const service = container.resolve(UserService);
    await service.purgeScheduledDeletions();
  });
  logger.info('AccountDeletionPurgeScheduler started (daily at 4:00 AM).');
}
