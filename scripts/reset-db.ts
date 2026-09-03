import 'dotenv/config';
import { Pool } from 'pg';

async function reset() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    // DROP SCHEMA public CASCADE requires owning the schema, which this DB
    // user doesn't in every environment. TRUNCATE only needs table-level
    // privileges and gets the same result (empty tables, sequences reset)
    // without touching schema ownership, so it works everywhere DROP SCHEMA
    // does and in places it doesn't.
    const { rows } = await client.query("select tablename from pg_tables where schemaname = 'public'");
    if (rows.length === 0) {
      console.log('No tables found in public schema, nothing to truncate.');
      return;
    }
    const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
    console.log('Truncating:', tables);
    await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
    console.log('Tables truncated. Run db:push and seeds next.');
  } finally {
    client.release();
    await pool.end();
  }
}

reset().catch((err) => {
  console.error(err);
  process.exit(1);
});
