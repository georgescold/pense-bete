-- Essort : une tâche peut être modifiée depuis Discord (texte, jour, heure).
-- Pour une tâche venue du CRM, la modification l'emporte sur les relectures
-- d'Airtable tant que l'action ou sa date ne changent pas dans le CRM.
ALTER TABLE essort_tasks ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
