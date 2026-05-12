import 'reflect-metadata';
import dotenv from 'dotenv';
import Database from './index';
import logger from '@/common/lib/logger';

dotenv.config();

async function runMigrations(): Promise<void> {
  const db = new Database();

  try {
    const migrated = await db.migrate();
    if (migrated) {
      logger.info('Migrations applied successfully.');
    }
  } catch (error) {
    logger.error(`Migration command failed - ${error}`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

runMigrations();

