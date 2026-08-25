CREATE TABLE IF NOT EXISTS "accounts" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "bank_id" integer REFERENCES "banks"("id") ON DELETE SET NULL,
  "currency" text NOT NULL,
  "label" text NOT NULL,
  "account_number_mask" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "transfer_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "from_transaction_id" integer REFERENCES "transactions"("id") ON DELETE SET NULL,
  "to_transaction_id" integer REFERENCES "transactions"("id") ON DELETE SET NULL,
  "link_type" text NOT NULL,
  "confidence" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "account_id" integer REFERENCES "accounts"("id") ON DELETE SET NULL;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "exclude_from_totals" boolean DEFAULT false NOT NULL;
