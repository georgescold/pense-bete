-- Schema for the pense-bête Discord reminder bot
-- Applied on Supabase project vfbxdgyyqcsvpjgzwsus on 2026-05-17

CREATE TABLE IF NOT EXISTS reminders (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  message TEXT NOT NULL,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('once', 'recurring')),
  cron_expression TEXT,
  run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL,
  raw_input TEXT NOT NULL,
  is_paused BOOLEAN NOT NULL DEFAULT FALSE,
  is_last_day_of_month BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminders_user_id ON reminders(user_id);
CREATE INDEX IF NOT EXISTS idx_reminders_next_run_at ON reminders(next_run_at) WHERE is_paused = FALSE;

-- The bot connects via the service_role key (bypass RLS),
-- but RLS is still enabled to deny accidental access via anon/publishable keys.
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
