import 'reflect-metadata';
import dotenv from 'dotenv';
import Database from './index';

dotenv.config();

async function runMigrations(): Promise<void> {
  const db = new Database();
  let failed = false;

  try {
    const migrated = await db.migrate();
    if (migrated) {
      console.log('  ✓ Migrations applied successfully.');
    } else {
      console.log('  ✓ No pending migrations — schema is up to date.');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message.split('\n')[0] : String(error);
    const cause = (error as any)?.cause;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : null;
    const fullMsg = causeMsg ? `${msg} → ${causeMsg}` : msg;

    if (/permission denied/i.test(fullMsg)) {
      console.error(
        `  ✗ Migration failed — missing schema permissions.\n` +
          `    Connect to your DB as a superuser and run:\n` +
          `      GRANT CREATE ON SCHEMA public TO <your_db_user>;\n` +
          `    Original error: ${fullMsg}`,
      );
    } else {
      console.error(`  ✗ Migration failed — ${fullMsg}`);
    }
    failed = true;
  } finally {
    await db.close();
  }

  if (failed) process.exit(1);
}

runMigrations();
