-- Essort : une tâche à heure fixe sonne trois fois, 1 h, 30 min et 10 min
-- avant. On compte les pings déjà envoyés (0 à 3) pour ne rien renvoyer
-- après un redémarrage ; un changement d'heure remet le compteur à zéro.
ALTER TABLE essort_tasks ADD COLUMN IF NOT EXISTS pings_sent SMALLINT NOT NULL DEFAULT 0;

-- Les tâches déjà pingées par l'ancien système (un seul ping, à l'heure) :
-- leur heure est passée, rien à renvoyer.
UPDATE essort_tasks SET pings_sent = 3 WHERE pinged_at IS NOT NULL;

-- Appliqué après le déploiement du code qui n'utilise plus cette colonne.
ALTER TABLE essort_tasks DROP COLUMN IF EXISTS pinged_at;
