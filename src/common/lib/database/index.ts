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
      logger.warn('No migrations found — skipping. Run "npm run db:generate" to create them.');
      return false;
    }

    try {
      await migrate(this.client, { migrationsFolder });
      return true;
    } catch (error) {
      logger.error(`Database migration failed - ${error}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default Database;
