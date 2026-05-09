import express from 'express';
import { container } from 'tsyringe';
import cron from 'node-cron';
import ExchangeRateController from './exchange-rate.controller';
import ExchangeRateService from './exchange-rate.service';
import ExchangeRateRepositoryImpl from './exchange-rate.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import logger from '@/common/lib/logger';

export async function registerExchangeRateDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.EXCHANGE_RATE, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IExchangeRateRepository', ExchangeRateRepositoryImpl);
  container.registerSingleton('IExchangeRateService', ExchangeRateService);
  container.registerSingleton<ExchangeRateService>(ExchangeRateService);
  container.registerSingleton<ExchangeRateController>(ExchangeRateController);

  const service = container.resolve(ExchangeRateService);
  service.fetchAndRefresh().catch(() => null);
  cron.schedule('0 */8 * * *', () => {
    service.fetchAndRefresh().catch(() => null);
  });
  logger.info('ExchangeRateScheduler started (3× per day, every 8 hours).');
}
