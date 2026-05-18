import 'reflect-metadata';
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { container, inject, injectable } from 'tsyringe';
import { APP_TOKENS } from '@/common/constants/app.tokens';
import { CONSTANTS } from '@/common/configuration/constants';
import { applyMounts } from '@/common/utils/route-registry';
import { setupSwagger } from '@/common/lib/swagger';
import AuthenticationMiddleware from '@/middleware/authentication.middleware';
import {
  allExceptionHandler,
  resourceNotFoundHandler,
} from '@/middleware/global-exception.middleware';
import { rateLimiter, probeBlocker } from '@/middleware/traffic-filter.middleware';
import logger from '@/common/lib/logger';
import syncEventBus from '@/common/lib/sync-event-bus';
import { IEmailConnectionRepository } from '@/modules/email-connection/email-connection.repository';
import IngestionService, { IIngestionService } from '@/modules/ingestion/ingestion.service';
import { IAuthenticatedRequest } from '@/common/types/interface';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { getIngestionQueue } from '@/modules/ingestion/ingestion.queue';

@injectable()
class App {
  private app: Express;

  constructor(
    @inject(APP_TOKENS.EXPRESS_APP) app: Express,
    @inject(AuthenticationMiddleware) private authMiddleware: AuthenticationMiddleware,
  ) {
    this.app = app;
    this.initiateMiddleware();
    this.initiateRoutes();
    setupSwagger(this.app);
    this.initiateErrorHandler();
  }

  private initiateMiddleware(): void {
    this.app.set('trust proxy', 1);
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(helmet());
    this.app.use(cors({ origin: CONSTANTS.FRONTEND_ORIGIN, credentials: true }));
    this.app.use(rateLimiter);
    this.app.use(probeBlocker);
    this.app.use(this.authMiddleware.authenticate);
  }

  private initiateRoutes(): void {
    this.initiateOAuthCallbackRoute();
    this.initiateSyncSSERoute();
    this.initiateBullBoard();
    applyMounts(this.app);
  }

  private initiateBullBoard(): void {
    const queue = getIngestionQueue();
    if (!queue) return;

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/api/admin/queues');

    createBullBoard({
      queues: [new BullMQAdapter(queue)],
      serverAdapter,
    });

    // Accept token from Authorization header OR ?token= query param so the
    // dashboard can be opened directly in a browser after admin login.
    const queueAuth = (req: Request, res: Response, next: NextFunction) => {
      const token =
        req.query.token as string | undefined ||
        req.headers['authorization']?.replace('Bearer ', '');

      if (!token) {
        res.status(401).json({ message: 'Admin access denied.' });
        return;
      }
      try {
        const payload = jwt.verify(token, CONSTANTS.ADMIN_JWT_SECRET) as { role: string };
        if (payload.role !== 'admin') throw new Error();
        next();
      } catch {
        res.status(401).json({ message: 'Admin access denied.' });
      }
    };

    // Disable CSP for this route so Bull Board's UI assets load correctly.
    this.app.use(
      '/api/admin/queues',
      helmet({ contentSecurityPolicy: false }),
      queueAuth,
      serverAdapter.getRouter(),
    );

    logger.info('[BullBoard] Queue dashboard available at /api/admin/queues');
  }

  private initiateOAuthCallbackRoute(): void {
    const APP_DEEP_LINK = 'fintrack://oauth/gmail';

    this.app.get('/api/email-connections/google/callback', async (req: Request, res: Response) => {
      const { code, state, error } = req.query;

      if (error || !code || !state) {
        res.redirect(`${APP_DEEP_LINK}?error=${encodeURIComponent(String(error ?? 'oauth_failed'))}`);
        return;
      }

      try {
        const decoded = JSON.parse(Buffer.from(state as string, 'base64url').toString());
        const userId = Number(decoded.userId);
        if (!userId) throw new Error('Invalid state');

        const EmailConnectionServiceClass = require('@/modules/email-connection/email-connection.service').default;
        const emailConnectionService = container.resolve<{ handleCallback(userId: number, data: { code: string; redirect_uri: string }): Promise<{ id: number }> }>(EmailConnectionServiceClass);

        const connection = await emailConnectionService.handleCallback(userId, {
          code: code as string,
          redirect_uri: CONSTANTS.GOOGLE_REDIRECT_URI,
        });

        const alreadyConnected = (connection as any).already_connected ? '1' : '0';
        res.redirect(`${APP_DEEP_LINK}?connection_id=${connection.id}&already_connected=${alreadyConnected}`);
      } catch (err) {
        logger.error(`Gmail OAuth server callback failed - ${err}`);
        res.redirect(`${APP_DEEP_LINK}?error=callback_failed`);
      }
    });
  }

  private initiateSyncSSERoute(): void {
    this.app.get('/api/email-connections/:id/sync-stream', async (req: Request, res: Response) => {
      const userId = (req as unknown as IAuthenticatedRequest).user?.id;
      if (!userId) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }

      const connectionId = parseInt(req.params.id as string, 10);
      if (isNaN(connectionId)) {
        res.status(400).json({ message: 'Invalid connection id' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering
      res.flushHeaders();

      const sendEvent = (event: string, data: unknown) => {
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          // client already disconnected
        }
      };

      sendEvent('connected', {});

      const channel = `sync:${connectionId}`;
      const busHandler = (payload: { event: string; data: unknown }) => {
        sendEvent(payload.event, payload.data);
        if (payload.event === 'done' || payload.event === 'error') {
          cleanup();
          res.end();
        }
      };

      const cleanup = () => syncEventBus.off(channel, busHandler);
      syncEventBus.on(channel, busHandler);
      req.on('close', cleanup);

      try {
        const connectionRepo = container.resolve<IEmailConnectionRepository>(
          'IEmailConnectionRepository',
        );
        const connection = await connectionRepo.findById(connectionId, userId);

        if (!connection || !connection.gmailLabelId) {
          sendEvent('error', { message: 'No connection or Gmail label configured' });
          cleanup();
          res.end();
          return;
        }

        const ingestionService = container.resolve<IIngestionService>(IngestionService);
        ingestionService.pollConnection(connectionId, 'manual').catch((err) => {
          logger.error(`SSE sync failed for connection ${connectionId} - ${err}`);
          sendEvent('error', { message: 'Sync failed' });
          cleanup();
          res.end();
        });
      } catch (err) {
        logger.error(`SSE setup failed for connection ${connectionId} - ${err}`);
        sendEvent('error', { message: 'Failed to start sync' });
        cleanup();
        res.end();
      }
    });
  }

  private initiateErrorHandler(): void {
    this.app.use(resourceNotFoundHandler);
    this.app.use(allExceptionHandler);
  }

  start(port: string): void {
    this.app.listen(parseInt(port, 10), () => {
      logger.info(`FinTrack API running on port ${port}`);
      logger.info(`Swagger docs: http://localhost:${port}/api-docs`);
    });
  }
}

export default App;
