#!/bin/sh
set -e

echo "→ Running migrations"
node dist/common/lib/database/migrate.js

# Run TS seed script without type-checking in production containers.
echo "→ Seeding demo account"
TS_NODE_TRANSPILE_ONLY=1 npm run seed:demo

echo "→ Starting Fintrack"
exec node dist/index.js
