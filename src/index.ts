import 'reflect-metadata';
import { container } from 'tsyringe';
import { configureContainer } from './init-dependencies';
import App from './app';
import AuthenticationMiddleware from '@/middleware/authentication.middleware';
import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';

async function bootstrap(): Promise<void> {
  try {
    await configureContainer();

    container.registerSingleton<AuthenticationMiddleware>(AuthenticationMiddleware);
    container.registerSingleton<App>(App);

    const app = container.resolve(App);
    app.start(CONSTANTS.PORT);
  } catch (error) {
    logger.error(`Failed to start application - ${error}`);
    process.exit(1);
  }
}

bootstrap();
