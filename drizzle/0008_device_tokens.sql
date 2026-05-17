CREATE TABLE IF NOT EXISTS "device_tokens" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "player_id" text NOT NULL UNIQUE,
  "platform" varchar(20),
  "created_at" timestamp DEFAULT now() NOT NULL
);
