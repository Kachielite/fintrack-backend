import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from '@/common/lib/redis';
import logger from '@/common/lib/logger';

const QUEUE_NAME = 'ingestion-connection';
const CONCURRENCY = parseInt(process.env.INGESTION_CONCURRENCY || '5', 10);

export interface ConnectionJobData {
  connectionId: number;
  source: 'cron' | 'manual';
}

let _queue: Queue<ConnectionJobData> | null = null;
let _worker: Worker<ConnectionJobData> | null = null;

export function getIngestionQueue(): Queue<ConnectionJobData> | null {
  const conn = getRedisConnection();
  if (!conn) return null;
  if (!_queue) {
    _queue = new Queue<ConnectionJobData>(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return _queue;
}

export function startIngestionWorker(): Worker<ConnectionJobData> | null {
  const conn = getRedisConnection();
  if (!conn) {
    logger.warn('[Queue] REDIS_URL not set — ingestion worker disabled, falling back to direct execution');
    return null;
  }

  const worker = new Worker<ConnectionJobData>(
    QUEUE_NAME,
    async (job: Job<ConnectionJobData>) => {
      const { connectionId, source } = job.data;
      // Lazy-resolve to avoid a circular import at module-load time.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { container } = require('tsyringe');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const IngestionServiceClass = require('@/modules/ingestion/ingestion.service').default;
      const service = container.resolve(IngestionServiceClass);
      await service.pollConnection(connectionId, source);
    },
    { connection: conn, concurrency: CONCURRENCY },
  );

  worker.on('completed', (job) =>
    logger.info(`[Queue] Job ${job.id} (conn=${job.data.connectionId}) completed`),
  );
  worker.on('failed', (job, err) =>
    logger.error(`[Queue] Job ${job?.id} (conn=${job?.data?.connectionId}) failed: ${err.message}`),
  );
  worker.on('error', (err) =>
    logger.error(`[Queue] Worker error: ${err.message}`),
  );

  _worker = worker;
  logger.info(`[Queue] Ingestion worker started (concurrency=${CONCURRENCY})`);
  return worker;
}
