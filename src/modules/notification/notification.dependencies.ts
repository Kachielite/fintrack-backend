import { container } from 'tsyringe';
import express from 'express';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import NotificationRepositoryImpl from './notification.repository';
import NotificationService from './notification.service';
import NotificationController from './notification.controller';

export async function registerNotificationDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.NOTIFICATION, {
    useFactory: () => express.Router(),
  });
  container.registerSingleton('INotificationRepository', NotificationRepositoryImpl);
  container.registerSingleton<NotificationService>(NotificationService);
  container.registerSingleton<NotificationController>(NotificationController);
}
