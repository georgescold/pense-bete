import cron from 'node-cron';
import type { Client } from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import { runBoardJob, runPrepJob, syncPendingPlans } from './service';

/**
 * Deux rendez-vous quotidiens, à l'heure de Paris :
 *  - 18h : on prépare la liste du lendemain (et on propose de reporter le non-fait) ;
 *  - 7h  : on clôture la veille (archivage Sheets) et on publie la checklist du jour.
 */
export function startDailyJobs(client: Client): void {
  for (const [expr, label] of [
    [config.DAILY_PREP_CRON, 'préparation 18h'],
    [config.DAILY_BOARD_CRON, 'checklist 7h'],
  ] as const) {
    if (!cron.validate(expr)) {
      logger.error({ expr, label }, 'expression cron invalide, job non planifié');
      return;
    }
  }

  cron.schedule(
    config.DAILY_PREP_CRON,
    () => {
      void runPrepJob(client).catch((err) => logger.error({ err }, 'echec du job de preparation'));
    },
    { timezone: config.TIMEZONE },
  );

  cron.schedule(
    config.DAILY_BOARD_CRON,
    () => {
      void runBoardJob(client).catch((err) => logger.error({ err }, 'echec du job de checklist'));
    },
    { timezone: config.TIMEZONE },
  );

  logger.info(
    { prep: config.DAILY_PREP_CRON, board: config.DAILY_BOARD_CRON, tz: config.TIMEZONE },
    'journees de travail planifiees',
  );

  // Rattrapage : si Google Sheets était indisponible ou non configuré, les
  // journées clôturées en attente repartent dès que possible.
  void syncPendingPlans().catch((err) => logger.error({ err }, 'echec du rattrapage Sheets'));
}
