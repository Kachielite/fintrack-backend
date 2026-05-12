import 'reflect-metadata';
import dotenv from 'dotenv';
import Database from './index';
import logger from '@/common/lib/logger';

dotenv.config();

async function runMigrations(): Promise<void> {
  const db = new Database();
  let failed = false;

  try {
    const migrated = await db.migrate();
    if (migrated) {
      logger.info('Migrations applied successfully.');
    } else {
      logger.info('No pending migrations — schema is up to date.');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message.split('\n')[0] : String(error);
    if (/permission denied/i.test(msg)) {
      logger.error(
        `Migration failed due to missing schema permissions.\n` +
          `Connect to your PostgreSQL database as a superuser and run:\n` +
          `  GRANT ALL ON SCHEMA public TO <your_db_user>;\n` +
          `  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO <your_db_user>;\n` +
          `Original error: ${msg}`,
      );
    } else {
      logger.error(`Migration command failed — ${msg}`);
    }
    failed = true;
  } finally {
    await db.close();
  }

  // Exit after closing the DB so the connection is cleanly released
  if (failed) process.exit(1);
}

runMigrations();
