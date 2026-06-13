CREATE TABLE IF NOT EXISTS {{STATE_TABLE}} (
  id text PRIMARY KEY,
  body jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  body_digest text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS {{BACKUP_TABLE}} (
  backup_id bigserial PRIMARY KEY,
  state_id text NOT NULL,
  revision integer NOT NULL,
  body jsonb NOT NULL,
  body_digest text NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS {{BACKUP_INDEX}}
ON {{BACKUP_TABLE}} (state_id, revision);
