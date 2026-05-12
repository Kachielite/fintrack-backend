import 'reflect-metadata';
import dotenv from 'dotenv';
import { execSync } from 'child_process';
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
      return;
    }

    // Fallback to schema push when SQL migration steps are already applied.
    logger.info('Applying schema with drizzle-kit push...');
    // drizzle-kit push may exit 0 even on errors; capture output to detect failures.
    let pushOutput = '';
    try {
      pushOutput = execSync('npm run db:push 2>&1', { encoding: 'utf8' });
    } catch (pushErr) {
      // execSync throws when the child process exits non-zero
      pushOutput = pushErr instanceof Error ? (pushErr as any).stdout ?? pushErr.message : String(pushErr);
      throw new Error(`drizzle-kit push failed:\n${pushOutput}`);
    }

    // drizzle-kit may print errors but still exit 0 — treat any error keyword as failure
    if (/permission denied|error:/i.test(pushOutput)) {
      throw new Error(`drizzle-kit push reported an error:\n${pushOutput}`);
    }

    logger.info('Schema push completed successfully.');
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
