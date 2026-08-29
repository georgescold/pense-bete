-- Sans réponse le soir, une journée est considérée comme du repos. Il faut
-- donc distinguer « j'ai choisi travail » de « je n'ai rien dit » : le défaut
-- devient 'undecided', que le job de 7h tranche en 'work' ou 'rest'.

ALTER TABLE day_plans DROP CONSTRAINT IF EXISTS day_plans_day_type_check;

ALTER TABLE day_plans
  ADD CONSTRAINT day_plans_day_type_check
  CHECK (day_type IN ('work', 'rest', 'undecided'));

ALTER TABLE day_plans ALTER COLUMN day_type SET DEFAULT 'undecided';
