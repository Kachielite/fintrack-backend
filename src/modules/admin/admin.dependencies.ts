import express from 'express';
import { container } from 'tsyringe';
import cron from 'node-cron';
import AdminController from './admin.controller';
import AdminService from './admin.service';
import { AdminRepositoryImpl, AiUsageRepositoryImpl } from './admin.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import logger from '@/common/lib/logger';

export async function registerAdminDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.ADMIN, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IAiUsageRepository', AiUsageRepositoryImpl);
  container.registerSingleton('IAdminRepository', AdminRepositoryImpl);
  container.registerSingleton<AdminService>(AdminService);
  container.register('IAdminService', { useToken: AdminService });
  container.registerSingleton<AdminController>(AdminController);

  cron.schedule('0 3 * * *', async () => {
    try {
      const service = container.resolve(AdminService);
      await service.takeSnapshot();
      logger.info('Admin daily snapshot saved.');
    } catch (err) {
      logger.error(`Admin snapshot failed - ${err}`);
    }
  });
  logger.info('AdminSnapshotScheduler started (daily at 3:00 AM).');
}
