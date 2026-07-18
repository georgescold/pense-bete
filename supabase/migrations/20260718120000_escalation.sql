-- Séquence de relance ("réveil") pour les rappels ponctuels.
-- Un rappel ponctuel n'est plus supprimé à l'envoi : il passe en attente de
-- validation et est renvoyé selon une échelle 4h → 6h → 1j → 3j → 1 semaine,
-- puis toutes les semaines, jusqu'à ce que l'utilisateur clique « Fait ».

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS escalation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS escalation_step INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'awaiting_ack', 'done'));

-- Index pour recharger rapidement les rappels en attente de relance au boot.
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status) WHERE is_paused = FALSE;
