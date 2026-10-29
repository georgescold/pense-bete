-- Tâches permanentes et périodes reliées au calendrier du CRM (29/10/2026).
--
-- Le calendrier du CRM et Discord ont le même fonctionnement, dans les deux
-- sens : une tâche du CRM sur plusieurs jours devient une tâche permanente ou
-- une période ici, et ce qu'on en fait ici (cocher, modifier, retirer) est
-- écrit dans le CRM. `crm_ref` = l'identifiant de la tâche dans le CRM
-- (table `taches`) ; null pour une tâche d'avant ce lien.

ALTER TABLE essort_spans ADD COLUMN IF NOT EXISTS crm_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_essort_spans_crm_ref
  ON essort_spans(crm_ref) WHERE crm_ref IS NOT NULL;
