import 'dotenv/config';
import bcrypt from 'bcrypt';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AdminUserSchema } from '../src/modules/admin/admin.schema';

const DEFAULT_ADMIN_EMAIL = 'admin@fintrack.app';
const DEFAULT_ADMIN_PASSWORD = 'ChangeMe123!';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const hash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 12);
await db.insert(AdminUserSchema)
  .values({ email: DEFAULT_ADMIN_EMAIL, passwordHash: hash })
  .onConflictDoNothing();

console.log(`Default admin seeded: ${DEFAULT_ADMIN_EMAIL}`);
await pool.end();
process.exit(0);
