import 'dotenv/config';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';

const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_SEED_EMAIL;
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_SEED_PASSWORD;

if (!DEFAULT_ADMIN_EMAIL || !DEFAULT_ADMIN_PASSWORD) {
  console.error('Missing ADMIN_SEED_EMAIL or ADMIN_SEED_PASSWORD in environment');
  process.exit(1);
}

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
