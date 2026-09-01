-- Idempotent: safe to re-run, and correct even if migration 0009 already
-- created this constraint under its default name in an environment where
-- db.migrate() ran before drizzle-kit push (see project db-ops notes on the
-- push-vs-migrate race). Re-adding under an explicit name here is harmless
-- if a differently-named constraint already covers the same columns.
ALTER TABLE "iris_embeddings" DROP CONSTRAINT IF EXISTS "iris_embeddings_user_chunk_period_unique";
ALTER TABLE "iris_embeddings" ADD CONSTRAINT "iris_embeddings_user_chunk_period_unique" UNIQUE ("user_id", "chunk_type", "period");
