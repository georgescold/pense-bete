import cron from 'node-cron';
import parser from 'cron-parser';
import type { Client } from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import { getPlan } from '../db/dailyRepository';
import { planDateFor, runBoardJob, runPrepJob, syncPendingPlans } from './service';
import { parisDateValue } from '../lib/datetime';

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

  // Ces deux rattrapages tapent en base au démarrage : si Supabase est encore
  // en train de revenir, une seule tentative les perdrait silencieusement.
  void withRetries('rattrapage Sheets', () => syncPendingPlans());
  void withRetries('rattrapage des journées', () => catchUpMissedJobs(client));
}

const BOOT_RETRY_MS = [5_000, 15_000, 30_000, 60_000];

/** Réessaie quelques fois avant d'abandonner, en le disant clairement. */
export async function withRetries(
  label: string,
  fn: () => Promise<void>,
  delays: number[] = BOOT_RETRY_MS,
): Promise<void> {
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await fn();
      return;
    } catch (err) {
      const delay = delays[attempt];
      if (delay === undefined) {
        logger.error({ err, label }, 'abandon apres plusieurs tentatives');
        return;
      }
      logger.warn({ err, label, attempt, retryInMs: delay }, 'echec, nouvelle tentative');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * `node-cron` ne déclenche que si le processus est vivant à la minute exacte :
 * un redémarrage à 7h00 fait perdre l'occurrence, sans erreur ni trace. On
 * vérifie donc au démarrage si le rendez-vous du jour est déjà passé sans
 * avoir laissé de message, et on le rejoue le cas échéant.
 *
 * L'opération est idempotente : c'est la présence de l'identifiant du message
 * en base qui fait foi, donc un boot après un déclenchement normal ne reposte
 * rien.
 */
export async function catchUpMissedJobs(client: Client): Promise<void> {
  const userId = config.DAILY_USER_ID as string;

  if (hasFiredToday(config.DAILY_BOARD_CRON)) {
    const plan = await getPlan(userId, planDateFor(0));
    if (!plan?.board_message_id) {
      logger.warn({ cron: config.DAILY_BOARD_CRON }, 'checklist du matin manquee, rattrapage');
      await runBoardJob(client);
    }
  }

  if (hasFiredToday(config.DAILY_PREP_CRON)) {
    const plan = await getPlan(userId, planDateFor(1));
    if (!plan?.prep_message_id) {
      logger.warn({ cron: config.DAILY_PREP_CRON }, 'preparation du soir manquee, rattrapage');
      await runPrepJob(client);
    }
  }
}

/** L'occurrence la plus récente de ce cron tombe-t-elle aujourd'hui, à Paris ? */
export function hasFiredToday(expr: string, now: Date = new Date()): boolean {
  try {
    const previous = parser
      .parseExpression(expr, { currentDate: now, tz: config.TIMEZONE })
      .prev()
      .toDate();
    return parisDateValue(0, previous) === parisDateValue(0, now);
  } catch (err) {
    logger.error({ err, expr }, 'cron illisible pour le rattrapage');
    return false;
  }
}
