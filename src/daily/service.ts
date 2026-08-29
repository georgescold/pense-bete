import { Client, userMention, type SendableChannels } from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import {
  ensurePlan,
  getPlan,
  listPlansToSync,
  listTasks,
  updatePlan,
  type DailyTaskRow,
  type DayPlanRow,
} from '../db/dailyRepository';
import { parisDateValue } from '../lib/datetime';
import { appendRows, isSheetsConfigured } from '../lib/sheets';
import { boardIntro, closingLine, prepIntro } from './messages';
import {
  buildBoardComponents,
  buildBoardEmbed,
  buildPrepComponents,
  buildPrepEmbed,
  formatPlanDate,
} from './ui';

function userId(): string {
  return config.DAILY_USER_ID as string;
}
function channelId(): string {
  return config.DAILY_CHANNEL_ID as string;
}

/** Date murale Paris : 0 = aujourd'hui, 1 = demain, -1 = hier. */
export function planDateFor(offsetDays: number, now: Date = new Date()): string {
  return parisDateValue(offsetDays, now);
}

/** Jour calendaire précédant une date murale 'YYYY-MM-DD'. */
export function previousPlanDate(planDate: string): string {
  const [y, m, d] = planDate.split('-').map(Number);
  const prev = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12) - 86_400_000);
  const mm = String(prev.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(prev.getUTCDate()).padStart(2, '0');
  return `${prev.getUTCFullYear()}-${mm}-${dd}`;
}

async function fetchChannel(client: Client): Promise<SendableChannels | null> {
  try {
    const ch = await client.channels.fetch(channelId());
    if (ch && ch.isTextBased() && ch.isSendable()) return ch;
    logger.error({ channel: channelId() }, 'salon des journees introuvable ou non textuel');
    return null;
  } catch (err) {
    logger.error({ err, channel: channelId() }, 'echec de recuperation du salon');
    return null;
  }
}

/** Tâches non cochées de la journée qui précède celle du plan. */
async function pendingTasksBefore(plan: DayPlanRow): Promise<DailyTaskRow[]> {
  const previous = await getPlan(plan.user_id, previousPlanDate(plan.plan_date));
  if (!previous) return [];
  const tasks = await listTasks(previous.id);
  return tasks.filter((t) => !t.is_done);
}

/** Réécrit les messages déjà postés pour refléter l'état courant du plan. */
export async function refreshPlanMessages(client: Client, plan: DayPlanRow): Promise<void> {
  const channel = await fetchChannel(client);
  if (!channel) return;
  const tasks = await listTasks(plan.id);

  if (plan.prep_message_id) {
    const pending = await pendingTasksBefore(plan);
    try {
      const msg = await channel.messages.fetch(plan.prep_message_id);
      await msg.edit({
        embeds: [buildPrepEmbed(plan, tasks, pending)],
        components: plan.status === 'draft' ? buildPrepComponents(plan, tasks, pending) : [],
      });
    } catch (err) {
      logger.warn({ err, id: plan.id }, 'message de preparation introuvable');
    }
  }

  if (plan.board_message_id) {
    try {
      const msg = await channel.messages.fetch(plan.board_message_id);
      await msg.edit({
        embeds: [buildBoardEmbed(plan, tasks)],
        components: buildBoardComponents(plan, tasks),
      });
    } catch (err) {
      logger.warn({ err, id: plan.id }, 'message de checklist introuvable');
    }
  }
}

// ---------------------------------------------------------------------------
// 18h — préparation de la journée du lendemain
// ---------------------------------------------------------------------------

export async function runPrepJob(client: Client): Promise<void> {
  const channel = await fetchChannel(client);
  if (!channel) return;

  const tomorrow = planDateFor(1);
  const guildId = (channel as { guildId?: string }).guildId ?? null;
  const plan = await ensurePlan(userId(), channelId(), guildId, tomorrow);
  const tasks = await listTasks(plan.id);
  const pending = await pendingTasksBefore(plan);

  const sent = await channel.send({
    content: `${userMention(userId())} ${prepIntro(formatPlanDate(tomorrow))}`,
    embeds: [buildPrepEmbed(plan, tasks, pending)],
    components: buildPrepComponents(plan, tasks, pending),
    allowedMentions: { users: [userId()] },
  });
  await updatePlan(plan.id, { prep_message_id: sent.id, status: 'draft' });
  logger.info(
    { id: plan.id, date: tomorrow, pending: pending.length },
    'preparation du soir postee',
  );
}

// ---------------------------------------------------------------------------
// 7h — présentation de la journée
// ---------------------------------------------------------------------------

export async function runBoardJob(client: Client): Promise<void> {
  const channel = await fetchChannel(client);
  if (!channel) return;

  // La veille n'est clôturée qu'au démarrage de la nouvelle journée : les tâches
  // restent ainsi cochables toute la soirée.
  const yesterday = await getPlan(userId(), planDateFor(-1));
  if (yesterday && yesterday.status !== 'closed') {
    await closePlan(client, yesterday);
  }

  const today = planDateFor(0);
  const guildId = (channel as { guildId?: string }).guildId ?? null;
  const plan = await ensurePlan(userId(), channelId(), guildId, today);
  const tasks = await listTasks(plan.id);
  const active = (await updatePlan(plan.id, { status: 'active' })) ?? {
    ...plan,
    status: 'active' as const,
  };

  const sent = await channel.send({
    content: `${userMention(userId())} ${boardIntro(tasks.length)}`,
    embeds: [buildBoardEmbed(active, tasks)],
    components: buildBoardComponents(active, tasks),
    allowedMentions: { users: [userId()] },
  });
  await updatePlan(plan.id, { board_message_id: sent.id });
  logger.info({ id: plan.id, date: today, tasks: tasks.length }, 'checklist du matin postee');
}

// ---------------------------------------------------------------------------
// Clôture + archivage
// ---------------------------------------------------------------------------

export async function closePlan(client: Client, plan: DayPlanRow): Promise<DayPlanRow> {
  const closed =
    (await updatePlan(plan.id, { status: 'closed', closed_at: new Date().toISOString() })) ?? plan;
  await refreshPlanMessages(client, closed);

  // Petit bilan public, dans l'esprit du bot sport.
  const tasks = await listTasks(closed.id);
  const done = tasks.filter((t) => t.is_done).length;
  const channel = await fetchChannel(client);
  if (channel) {
    await channel
      .send({ content: closingLine(done, tasks.length) })
      .catch((err) => logger.warn({ err, id: closed.id }, 'bilan de cloture non envoye'));
  }

  await syncPendingPlans();
  return closed;
}

function parisTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: config.TIMEZONE,
  });
}

function planToRows(plan: DayPlanRow, tasks: DailyTaskRow[]): string[][] {
  const jour = formatPlanDate(plan.plan_date).split(' ')[0] ?? '';
  const done = tasks.filter((t) => t.is_done).length;
  const bilan = `${done}/${tasks.length}`;
  if (tasks.length === 0) {
    return [[plan.plan_date, jour, '(aucune tâche)', '—', 'non', '', '0/0']];
  }
  return tasks.map((t) => [
    plan.plan_date,
    jour,
    t.label,
    t.is_done ? 'Fait' : 'Non fait',
    t.carried_over ? 'oui' : 'non',
    parisTime(t.done_at),
    bilan,
  ]);
}

/**
 * Pousse dans Google Sheets toutes les journées clôturées pas encore archivées.
 * Tant que le compte de service n'est pas configuré, les journées s'accumulent
 * en base et sont rattrapées au premier passage réussi — rien n'est perdu.
 */
export async function syncPendingPlans(): Promise<void> {
  const plans = await listPlansToSync();
  if (plans.length === 0) return;
  if (!isSheetsConfigured()) {
    logger.warn(
      { pending: plans.length },
      'Google Sheets non configure : journees en attente archivage',
    );
    return;
  }
  for (const plan of plans) {
    try {
      const tasks = await listTasks(plan.id);
      await appendRows(planToRows(plan, tasks));
      await updatePlan(plan.id, { sheet_synced_at: new Date().toISOString() });
      logger.info({ id: plan.id, date: plan.plan_date }, 'journee archivee dans Google Sheets');
    } catch (err) {
      // On s'arrête au premier échec : le prochain passage reprendra la file.
      logger.error({ err, id: plan.id }, 'echec archivage Google Sheets');
      return;
    }
  }
}
