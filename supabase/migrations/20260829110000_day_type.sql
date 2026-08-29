-- Une journée est soit travaillée, soit une journée de repos. Le type est
-- choisi la veille au soir et conditionne le ton du bot : on ne reproche pas
-- une liste vide un jour de repos.

ALTER TABLE day_plans
  ADD COLUMN IF NOT EXISTS day_type TEXT NOT NULL DEFAULT 'work'
    CHECK (day_type IN ('work', 'rest'));
