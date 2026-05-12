#!/bin/sh
set -e

echo "→ Running migrations"
node dist/common/lib/database/migrate.js

echo "→ Seeding demo account"
npm run seed:demo

echo "→ Starting Fintrack"
exec node dist/index.js
