import 'reflect-metadata';
import dotenv from 'dotenv';
import { execSync } from 'child_process';
import Database from './index';
import logger from '@/common/lib/logger';

dotenv.config();

async function runMigrations(): Promise<void> {
  const db = new Database();

  try {
    const migrated = await db.migrate();
    if (migrated) {
      logger.info('Migrations applied successfully.');
      return;
    }

    // Fallback to schema push when SQL migration step is skipped or partially applied.
    logger.info('Applying schema with drizzle-kit push...');
    execSync('npm run db:push', { stdio: 'inherit' });
    logger.info('Schema push completed successfully.');
  } catch (error) {
    const msg = error instanceof Error ? error.message.split('\n')[0] : String(error);
    if (msg.includes('permission denied')) {
      logger.error(
        `Migration failed due to missing schema permissions.\n` +
          `Fix: connect to your PostgreSQL database as a superuser and run:\n` +
          `  GRANT ALL ON SCHEMA public TO <your_db_user>;\n` +
          `  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO <your_db_user>;\n` +
          `Original error: ${msg}`,
      );
    } else {
      logger.error(`Migration command failed — ${msg}`);
    }
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

runMigrations();
