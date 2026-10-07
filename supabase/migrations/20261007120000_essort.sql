-- Essort : tableau quotidien de 6h par personne (Loys, Enzo), construit à
-- partir du CRM Airtable (lu, jamais modifié) et complété à la main.
-- Une tâche non faite ne disparaît pas le lendemain : elle passe sur le
-- tableau du jour suivant (même ligne), jusqu'à être faite ou retirée.
-- Les tâches validées sont recopiées dans l'onglet « Essort » du Google Sheet.

CREATE TABLE IF NOT EXISTS essort_boards (
  id BIGSERIAL PRIMARY KEY,
  -- Valeur du champ « Gestion » d'Airtable : 'Loys' ou 'Enzo'.
  person TEXT NOT NULL,
  -- Jour couvert, en date murale Europe/Paris.
  board_date DATE NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  -- Ce qui s'affiche sous la liste sans être cochable : à venir, sans date,
  -- fait mais pas mis à jour dans Airtable, sans responsable, erreur de lecture.
  extras JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Dernière lecture d'Airtable réussie pour ce tableau.
  read_at TIMESTAMPTZ,
  -- Le message d'un jour passé perd ses boutons.
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (person, board_date)
);

CREATE TABLE IF NOT EXISTS essort_tasks (
  id BIGSERIAL PRIMARY KEY,
  board_id BIGINT NOT NULL REFERENCES essort_boards(id) ON DELETE CASCADE,
  -- 'airtable' : déduite d'un lead ; 'manual' : ajoutée depuis Discord.
  source TEXT NOT NULL CHECK (source IN ('airtable', 'manual')),
  -- Lead Airtable (rec…) et « quelle » action de ce lead : action + date.
  -- Une action validée ne revient pas tant qu'Airtable n'a pas changé.
  record_id TEXT,
  signature TEXT,
  label TEXT NOT NULL,
  details TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  is_done BOOLEAN NOT NULL DEFAULT FALSE,
  done_at TIMESTAMPTZ,
  done_by TEXT,
  -- Retirée du tableau depuis Discord. Une tâche Airtable retirée reste en
  -- base pour ne pas réapparaître tant que le lead n'a pas changé.
  dismissed_at TIMESTAMPTZ,
  -- Ligne écrite dans le Google Sheet (ex. « Essort!A12:H12 »), NULL sinon.
  sheet_range TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_essort_boards_person ON essort_boards(person, board_date DESC);
CREATE INDEX IF NOT EXISTS idx_essort_tasks_board ON essort_tasks(board_id, position);
CREATE INDEX IF NOT EXISTS idx_essort_tasks_handled_record
  ON essort_tasks(record_id, signature) WHERE is_done OR dismissed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_essort_tasks_unsynced
  ON essort_tasks(id) WHERE is_done AND sheet_range IS NULL;

-- Comme les autres tables : accès par la service_role key uniquement.
ALTER TABLE essort_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE essort_tasks ENABLE ROW LEVEL SECURITY;
