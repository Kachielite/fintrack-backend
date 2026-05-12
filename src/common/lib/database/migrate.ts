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
    logger.error(`Migration command failed - ${error}`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

runMigrations();
