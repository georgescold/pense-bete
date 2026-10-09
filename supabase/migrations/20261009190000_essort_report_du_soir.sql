-- Essort : plus aucun report automatique. À 19h, le bot demande quelles tâches
-- non faites passer au lendemain ; sans réponse, rien ne bouge et les tâches
-- restent affichées sur le jour où elles étaient prévues.

-- Message « Reporter à demain ? » du soir, et le moment où quelqu'un y a
-- répondu (pour ne pas reposer la question après un redémarrage).
ALTER TABLE essort_boards ADD COLUMN IF NOT EXISTS evening_message_id TEXT;
ALTER TABLE essort_boards ADD COLUMN IF NOT EXISTS evening_answered_at TIMESTAMPTZ;
