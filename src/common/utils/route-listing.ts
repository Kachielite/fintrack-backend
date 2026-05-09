import { Express } from 'express';
import logger from '@/common/lib/logger';

export function printRoutes(app: Express): void {
  const routes: string[] = [];

  app._router?.stack?.forEach((middleware: any) => {
    if (middleware.route) {
      const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
      routes.push(`${methods} ${middleware.route.path}`);
    } else if (middleware.name === 'router') {
      middleware.handle?.stack?.forEach((handler: any) => {
        if (handler.route) {
          const methods = Object.keys(handler.route.methods).join(', ').toUpperCase();
          routes.push(`${methods} ${handler.route.path}`);
        }
      });
    }
  });

  logger.info(`Registered routes:\n${routes.join('\n')}`);
}
