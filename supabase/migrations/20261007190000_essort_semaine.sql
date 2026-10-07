-- Essort : message « semaine » en plus du message du jour, tâches planifiées à
-- une date (tableau d'un jour futur) et à une heure, avec un ping à l'heure.

-- Heure murale Europe/Paris 'HH:MM' : posée à la main ou lue dans
-- « Prochain événement » (« à 11h »).
ALTER TABLE essort_tasks ADD COLUMN IF NOT EXISTS due_time TEXT
  CHECK (due_time IS NULL OR due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
-- Ping « ⏰ c'est l'heure » déjà envoyé : pas de doublon après un redémarrage.
ALTER TABLE essort_tasks ADD COLUMN IF NOT EXISTS pinged_at TIMESTAMPTZ;

-- Le tableau d'un jour porte deux messages : la semaine, puis la journée.
ALTER TABLE essort_boards ADD COLUMN IF NOT EXISTS week_message_id TEXT;
