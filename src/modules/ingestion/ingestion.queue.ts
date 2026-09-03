import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from '@/common/lib/redis';
import logger from '@/common/lib/logger';

const QUEUE_NAME = 'ingestion-connection';
const CONCURRENCY = parseInt(process.env.INGESTION_CONCURRENCY || '5', 10);

export interface ConnectionJobData {
  connectionId: number;
  source: 'cron' | 'manual';
  // Gmail list pageToken to resume a chunked manual poll from — see
  // fintrack-backend#137. Absent for a fresh poll (cron, or the first chunk
  // of a manual one).
  pageToken?: string;
  // The backfill's `after:YYYY/MM/DD` cutoff, pinned on the first chunk and
  // carried forward unchanged on every follow-up job. Gmail's pageToken is only
  // valid for the exact query that produced it, so recomputing "N days ago"
  // fresh on each chunk would silently change the query mid-pagination the
  // moment a backfill run crosses a day boundary (see fintrack-backend#158).
  backfillCutoffDate?: string;
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
      const { connectionId, source, pageToken, backfillCutoffDate } = job.data;
      // Lazy-resolve to avoid a circular import at module-load time.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { container } = require('tsyringe');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const IngestionServiceClass = require('@/modules/ingestion/ingestion.service').default;
      const service = container.resolve(IngestionServiceClass);
      await service.pollConnection(connectionId, source, pageToken, backfillCutoffDate, true);
    },
    { connection: conn, concurrency: CONCURRENCY },
  );

  worker.on('completed', (job) =>
    logger.info(`[Queue] Job ${job.id} (conn=${job.data.connectionId}) completed`),
  );
  worker.on('failed', (job, err) => {
    logger.error(`[Queue] Job ${job?.id} (conn=${job?.data?.connectionId}) failed: ${err.message}`);
    if (!job) return;

    // pollConnection now rethrows so this fires on every failed attempt, not
    // just the last one. Only reconcile once retries are actually exhausted
    // (this is where BullMQ's own attempt count lives, not in pollConnection),
    // and only for a manual chunk, since that's the chain whose failure leaves
    // backfillPending stuck true and drops the rest of the backlog with no
    // other retry path. See fintrack-backend#158.
    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade >= maxAttempts;
    if (isFinalAttempt && job.data.source === 'manual') {
      // Lazy-resolve to avoid a circular import at module-load time.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { container } = require('tsyringe');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const IngestionServiceClass = require('@/modules/ingestion/ingestion.service').default;
      const service = container.resolve(IngestionServiceClass);
      service
        .reconcileFailedBackfill(job.data.connectionId)
        .catch((reconcileErr: unknown) =>
          logger.error(
            `[Queue] Failed to reconcile backfill state for connection ${job.data.connectionId} - ${reconcileErr}`,
          ),
        );
    }
  });
  worker.on('error', (err) =>
    logger.error(`[Queue] Worker error: ${err.message}`),
  );

  _worker = worker;
  logger.info(`[Queue] Ingestion worker started (concurrency=${CONCURRENCY})`);
  return worker;
}
