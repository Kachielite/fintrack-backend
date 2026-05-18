import IORedis from 'ioredis';
import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';

let _connection: IORedis | null = null;

export function getRedisConnection(): IORedis | null {
  if (!CONSTANTS.REDIS_URL) return null;
  if (!_connection) {
    _connection = new IORedis(CONSTANTS.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    _connection.on('error', (err) => logger.warn(`[Redis] ${err.message}`));
  }
  return _connection;
}
