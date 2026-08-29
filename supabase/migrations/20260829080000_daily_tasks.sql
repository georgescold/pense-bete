-- Journées de travail : liste de tâches préparée la veille à 18h,
-- présentée et cochée le lendemain à 7h, puis archivée dans Google Sheets.

CREATE TABLE IF NOT EXISTS day_plans (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  -- Jour couvert par le plan, en date murale Europe/Paris (pas un timestamp).
  plan_date DATE NOT NULL,
  -- 'draft'  : en cours de préparation la veille au soir
  -- 'active' : publié le matin, tâches cochables
  -- 'closed' : journée terminée, archivée
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  -- Message du soir (préparation) et message du matin (checklist).
  prep_message_id TEXT,
  board_message_id TEXT,
  closed_at TIMESTAMPTZ,
  sheet_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, plan_date)
);

CREATE TABLE IF NOT EXISTS daily_tasks (
  id BIGSERIAL PRIMARY KEY,
  plan_id BIGINT NOT NULL REFERENCES day_plans(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_done BOOLEAN NOT NULL DEFAULT FALSE,
  done_at TIMESTAMPTZ,
  -- TRUE si la tâche a été reportée depuis une journée précédente.
  carried_over BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_day_plans_date ON day_plans(user_id, plan_date DESC);
CREATE INDEX IF NOT EXISTS idx_day_plans_unsynced ON day_plans(status) WHERE sheet_synced_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_daily_tasks_plan ON daily_tasks(plan_id, position);

-- Comme reminders : le bot passe par la service_role key, RLS activé pour
-- refuser tout accès accidentel via une clé anon/publishable.
ALTER TABLE day_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_tasks ENABLE ROW LEVEL SECURITY;
