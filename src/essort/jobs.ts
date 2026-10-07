import cron from 'node-cron';
import type { Client } from 'discord.js';
import { config, essortMembers } from '../config';
import { logger } from '../logger';
import { hasFiredToday, withRetries } from '../daily/jobs';
import { onRemindersChanged } from '../lib/reminderEvents';
import { publishBoards, refreshForUser, restoreTodayPings, syncDoneTasks } from './service';

/**
 * Tous les jours à 6h (heure de Paris), dans le salon de chaque personne : le
 * planning de la semaine puis le message du jour. Relecture d'Airtable à 12h
 * et 17h : les mêmes messages sont mis à jour.
 *
 * Le rendez-vous passe aussi par la base Supabase chaque matin : il la garde
 * éveillée, alors qu'elle se mettait en pause faute d'activité.
 */
export function startEssortJobs(client: Client): void {
  for (const [expr, label] of [
    [config.ESSORT_CRON, 'ESSORT_CRON'],
    [config.ESSORT_REFRESH_CRON, 'ESSORT_REFRESH_CRON'],
  ] as const) {
    if (!cron.validate(expr)) {
      logger.error({ expr, label }, 'expression cron invalide, tableaux Essort non planifies');
      return;
    }
  }

  cron.schedule(
    config.ESSORT_CRON,
    () => {
      void withRetries('tableaux Essort', () => publishBoards(client));
    },
    { timezone: config.TIMEZONE },
  );

  // Même opération que le matin : elle met à jour les messages déjà postés et
  // ne publie que ce qui manquerait (6h raté).
  cron.schedule(
    config.ESSORT_REFRESH_CRON,
    () => {
      void withRetries('relecture Airtable', () => publishBoards(client));
    },
    { timezone: config.TIMEZONE },
  );

  logger.info(
    {
      cron: config.ESSORT_CRON,
      refresh: config.ESSORT_REFRESH_CRON,
      tz: config.TIMEZONE,
      people: essortMembers.map((m) => m.person),
    },
    'tableaux Essort planifies',
  );

  // `node-cron` ne rejoue pas une occurrence manquée : un redémarrage à 6h00
  // ferait sauter la journée. Au démarrage, on publie ce qui manque et on met
  // à jour le reste (sans nouvelle mention) : après un déploiement, les
  // messages du jour suivent aussitôt.
  if (hasFiredToday(config.ESSORT_CRON)) {
    void withRetries('rattrapage Essort', () => publishBoards(client));
  }
  // Les minuteurs des pings ne survivent pas à un redémarrage.
  void withRetries('pings du jour', () => restoreTodayPings(client));
  void syncDoneTasks();

  // Un rappel créé, mis en pause ou supprimé apparaît aussitôt dans le planning.
  onRemindersChanged((c, userId) => refreshForUser(c, userId));
}
