import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { injectable } from 'tsyringe';
import path from 'path';
import fs from 'fs';
import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';

@injectable()
class Database {
  private pool: Pool;
  public client: NodePgDatabase;

  constructor() {
    this.pool = new Pool({ connectionString: CONSTANTS.DATABASE_URL });
    this.client = drizzle(this.pool);
  }

  async migrate(): Promise<boolean> {
    const migrationsFolder = path.join(process.cwd(), 'drizzle');
    const journal = path.join(migrationsFolder, 'meta', '_journal.json');

    if (!fs.existsSync(journal)) {
      throw new Error(`Migration journal not found at ${journal}. Ensure the drizzle/ folder is included in the Docker image.`);
    }

    // Ensure the connecting role has CREATE on the public schema.
    // Required by PostgreSQL 15+ which revoked this default privilege.
    try {
      await this.pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER;');
      logger.info('Schema public permissions granted.');
    } catch (grantError: unknown) {
      logger.warn(
        `Could not GRANT ALL ON SCHEMA public — proceeding anyway. ` +
          `If migrations fail with "permission denied", ask your DBA to run: ` +
          `GRANT ALL ON SCHEMA public TO <your_db_user>; ` +
          `(${grantError instanceof Error ? grantError.message.split('\n')[0] : grantError})`,
      );
    }

    await migrate(this.client, { migrationsFolder });
    return true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default Database;
