import express from 'express';
import { container } from 'tsyringe';
import EmailConnectionController from './email-connection.controller';
import EmailConnectionService from './email-connection.service';
import EmailConnectionRepositoryImpl from './email-connection.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';

export async function registerEmailConnectionDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.EMAIL_CONNECTION, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IEmailConnectionRepository', EmailConnectionRepositoryImpl);
  container.registerSingleton<EmailConnectionService>(EmailConnectionService);
  container.registerSingleton<EmailConnectionController>(EmailConnectionController);

}
