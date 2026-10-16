-- Essort : deux nouvelles sortes de tâches, ajoutées depuis Discord.
--  - « permanente » : affichée chaque jour, jusqu'à ce qu'elle soit cochée ;
--  - « période » : affichée chaque jour d'un créneau (début → fin, jour et
--    heure). À la fin du créneau, le bot demande si elle a pu être faite :
--    faite, reportée (nouvelle fin) ou abandonnée. Sans réponse, rien ne bouge.
-- Chaque jour où elle s'affiche, la tâche a sa ligne dans essort_tasks
-- (span_id) : elle se coche, se retire et se modifie comme les autres.

CREATE TABLE IF NOT EXISTS essort_spans (
  id BIGSERIAL PRIMARY KEY,
  -- 'Loys' ou 'Enzo', et le salon de son tableau.
  person TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('permanent', 'period')),
  label TEXT NOT NULL,
  -- Dates murales Europe/Paris et heures 'HH:MM'. Une tâche permanente n'a
  -- pas de fin ; une période a toujours un jour et une heure de fin.
  start_date DATE NOT NULL,
  start_time TEXT,
  end_date DATE,
  end_time TEXT,
  done_at TIMESTAMPTZ,
  done_by TEXT,
  dismissed_at TIMESTAMPTZ,
  -- Question de fin de période : posée une seule fois, remise à zéro par un report.
  asked_at TIMESTAMPTZ,
  ask_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind = 'permanent' OR (end_date IS NOT NULL AND end_time IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_essort_spans_open
  ON essort_spans(person) WHERE done_at IS NULL AND dismissed_at IS NULL;

-- Comme les autres tables : accès par la service_role key uniquement.
ALTER TABLE essort_spans ENABLE ROW LEVEL SECURITY;

ALTER TABLE essort_tasks
  ADD COLUMN IF NOT EXISTS span_id BIGINT REFERENCES essort_spans(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_essort_tasks_span ON essort_tasks(span_id) WHERE span_id IS NOT NULL;
