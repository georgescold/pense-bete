-- Essort : une tâche permanente ou une période peut être pour toute l'équipe
-- (Loys et Enzo). Elle s'affiche alors sur le tableau de chacun ; cochée par
-- l'un, elle disparaît du tableau de l'autre.
ALTER TABLE essort_spans ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT FALSE;
