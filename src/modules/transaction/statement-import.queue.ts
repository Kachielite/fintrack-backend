import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from '@/common/lib/redis';
import logger from '@/common/lib/logger';
import type { PreparedImport } from './transaction.service';

const QUEUE_NAME = 'statement-import';
const CONCURRENCY = parseInt(process.env.STATEMENT_IMPORT_CONCURRENCY || '3', 10);

export interface StatementImportJobData {
  userId: number;
  prepared: PreparedImport;
}

let _queue: Queue<StatementImportJobData> | null = null;

export function getStatementImportQueue(): Queue<StatementImportJobData> | null {
  const conn = getRedisConnection();
  if (!conn) return null;
  if (!_queue) {
    _queue = new Queue<StatementImportJobData>(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 1, // re-running a partial import would re-categorize/re-dedupe from scratch; surface the failure instead of silently retrying
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return _queue;
}

export function startStatementImportWorker(): Worker<StatementImportJobData> | null {
  const conn = getRedisConnection();
  if (!conn) {
    logger.warn('[Queue] REDIS_URL not set — statement-import worker disabled, falling back to direct execution');
    return null;
  }

  const worker = new Worker<StatementImportJobData>(
    QUEUE_NAME,
    async (job: Job<StatementImportJobData>) => {
      const { userId, prepared } = job.data;
      // Lazy-resolve to avoid a circular import at module-load time.
      const { container } = require('tsyringe');
      const TransactionServiceClass = require('@/modules/transaction/transaction.service').default;
      const service = container.resolve(TransactionServiceClass);
      await service.processAndNotifyImport(userId, prepared);
    },
    { connection: conn, concurrency: CONCURRENCY },
  );

  worker.on('completed', (job) =>
    logger.info(`[Queue] Job ${job.id} (user=${job.data.userId}) completed`),
  );
  worker.on('failed', (job, err) =>
    logger.error(`[Queue] Job ${job?.id} (user=${job?.data?.userId}) failed: ${err.message}`),
  );
  worker.on('error', (err) =>
    logger.error(`[Queue] Worker error: ${err.message}`),
  );

  logger.info(`[Queue] Statement-import worker started (concurrency=${CONCURRENCY})`);
  return worker;
}
