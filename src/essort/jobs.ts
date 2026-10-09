import cron from 'node-cron';
import type { Client } from 'discord.js';
import { config, essortMembers } from '../config';
import { logger } from '../logger';
import { hasFiredToday, withRetries } from '../daily/jobs';
import { onRemindersChanged } from '../lib/reminderEvents';
import {
  askCarryOver,
  publishBoards,
  refreshForUser,
  restoreTodayPings,
  syncDoneTasks,
  syncFromCrm,
} from './service';

/**
 * Tous les jours à 6h (heure de Paris), dans le salon de chaque personne : le
 * planning de la semaine puis le message du jour. Airtable est relu toutes les
 * 5 minutes : un changement dans le CRM met à jour ces messages et le bot dit
 * ce qu'il a compris. À 19h, s'il reste des tâches,
 * le bot demande lesquelles reporter au lendemain (rien n'est reporté seul).
 *
 * Le rendez-vous passe aussi par la base Supabase chaque matin : il la garde
 * éveillée, alors qu'elle se mettait en pause faute d'activité.
 */
export function startEssortJobs(client: Client): void {
  for (const [expr, label] of [
    [config.ESSORT_CRON, 'ESSORT_CRON'],
    [config.ESSORT_SYNC_CRON, 'ESSORT_SYNC_CRON'],
    [config.ESSORT_EVENING_CRON, 'ESSORT_EVENING_CRON'],
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

  // Pas de nouvel essai : la prochaine synchro est dans 5 minutes.
  cron.schedule(
    config.ESSORT_SYNC_CRON,
    () => {
      void syncFromCrm(client).catch((err) => logger.error({ err }, 'synchro CRM en echec'));
    },
    { timezone: config.TIMEZONE },
  );

  cron.schedule(
    config.ESSORT_EVENING_CRON,
    () => {
      void withRetries('question du soir', () => askCarryOver(client));
    },
    { timezone: config.TIMEZONE },
  );

  logger.info(
    {
      cron: config.ESSORT_CRON,
      sync: config.ESSORT_SYNC_CRON,
      evening: config.ESSORT_EVENING_CRON,
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
  // Idem pour la question du soir : posée une seule fois par jour.
  if (hasFiredToday(config.ESSORT_EVENING_CRON)) {
    void withRetries('rattrapage question du soir', () => askCarryOver(client));
  }
  // Les minuteurs des pings ne survivent pas à un redémarrage.
  void withRetries('pings du jour', () => restoreTodayPings(client));
  void syncDoneTasks();

  // Un rappel créé, mis en pause ou supprimé apparaît aussitôt dans le planning.
  onRemindersChanged((c, userId) => refreshForUser(c, userId));
}
