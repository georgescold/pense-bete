-- Mémorise l'ID du message de récap épinglé dans le salon, pour pouvoir le
-- dés-épingler quand le rappel est validé ou supprimé.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS pin_message_id TEXT;
