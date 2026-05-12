#!/bin/sh
set -e

# ── PostgreSQL 15+ compatibility ───────────────────────────────────────────────
# PostgreSQL 15 revoked the default CREATE privilege on the public schema.
# Try to grant it to the connecting role before running any DDL.
echo "→ Granting schema permissions"
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO CURRENT_USER;')
  .then(() => { console.log('  ✓ Schema permissions granted'); })
  .catch(e => {
    console.warn('  ⚠ Could not auto-grant schema permissions:', e.message);
    console.warn('  If migrations fail, run as a DB superuser:');
    console.warn('    GRANT ALL ON SCHEMA public TO <your_db_user>;');
    console.warn('    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO <your_db_user>;');
  })
  .finally(() => pool.end());
" || true

echo "→ Running migrations"
node dist/common/lib/database/migrate.js

# Run TS seed script without type-checking in production containers.
# Non-fatal: a seed failure must never prevent the server from starting.
echo "→ Seeding demo account"
TS_NODE_TRANSPILE_ONLY=1 npm run seed:demo || echo "  ⚠ Demo seed failed (non-fatal) — server will still start"

echo "→ Starting Fintrack"
exec node dist/index.js
