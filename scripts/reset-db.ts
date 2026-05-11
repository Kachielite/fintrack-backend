import 'dotenv/config';
import { Pool } from 'pg';

async function reset() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log('Dropping public schema...');
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO public');
    console.log('Schema wiped. Run db:push and seeds next.');
  } finally {
    client.release();
    await pool.end();
  }
}

reset().catch((err) => {
  console.error(err);
  process.exit(1);
});
