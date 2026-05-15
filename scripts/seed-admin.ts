import 'dotenv/config';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';

const DEFAULT_ADMIN_EMAIL = 'admin@fintrack.app';
const DEFAULT_ADMIN_PASSWORD = 'ChangeMe123!';

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const hash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 12);
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, is_active, created_at, updated_at)
     VALUES ($1, $2, true, NOW(), NOW())
     ON CONFLICT (email) DO NOTHING`,
    [DEFAULT_ADMIN_EMAIL, hash],
  );

  console.log(`Default admin seeded: ${DEFAULT_ADMIN_EMAIL}`);
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
