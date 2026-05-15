ALTER TABLE banks
  ADD COLUMN IF NOT EXISTS known_sender_domains text[] NOT NULL DEFAULT '{}';
