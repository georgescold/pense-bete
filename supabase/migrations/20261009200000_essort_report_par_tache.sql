-- Essort : la question de 19h se répond tâche par tâche (un clic reporte, un
-- second annule). On retient d'où vient une tâche reportée pour pouvoir
-- l'annuler et la montrer comme « reportée » dans la question du soir.
--
-- Volontairement SANS clé étrangère : une seconde relation vers essort_boards
-- rendrait ambigus les `essort_boards!inner(...)` des requêtes du bot
-- (PostgREST refuse alors l'embed).
ALTER TABLE essort_tasks ADD COLUMN IF NOT EXISTS carried_from BIGINT;
