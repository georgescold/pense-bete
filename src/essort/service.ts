import { Client, userMention, type BaseMessageOptions, type SendableChannels } from 'discord.js';
import { config, essortMembers, type EssortMember, type EssortPerson } from '../config';
import { logger } from '../logger';
import {
  addTask,
  deleteTask,
  ensureBoard,
  getBoard,
  getBoardById,
  getTask,
  listBoardsToArchive,
  listAirtableTasksFor,
  listPlannedTasks,
  listTasks,
  listTasksToSync,
  moveTask,
  updateBoard,
  updateTask,
  type EssortBoardRow,
  type EssortTaskRow,
  type TaskWithBoard,
} from '../db/essortRepository';
import { listRemindersByUser } from '../db/repository';
import { formatPlanDate } from '../daily/ui';
import { parisDateValue, zonedWallClockToUtc } from '../lib/datetime';
import { expandOccurrences } from '../lib/embeds';
import { appendRowsTo, clearRange, isSheetsConfigured } from '../lib/sheets';
import { fetchLeads, recordUrl } from './airtable';
import { addDays, buildAgenda, padDate, WEEK_DAYS, type Agenda } from './planner';
import {
  buildDayComponents,
  buildDayEmbed,
  buildEveningMessage,
  buildWeekComponents,
  buildWeekEmbed,
  dayIntro,
  dayOrder,
  type TimedLine,
  type WeekItem,
} from './ui';

/** Date murale Paris du jour, au format 'YYYY-MM-DD'. */
export function essortToday(now: Date = new Date()): string {
  return padDate(parisDateValue(0, now));
}

function memberOf(person: EssortPerson): EssortMember | undefined {
  return essortMembers.find((m) => m.person === person);
}

async function fetchChannel(client: Client, channelId: string): Promise<SendableChannels | null> {
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch && ch.isTextBased() && ch.isSendable()) return ch;
    logger.error({ channel: channelId }, 'salon Essort introuvable ou non textuel');
    return null;
  } catch (err) {
    logger.error({ err, channel: channelId }, 'echec de recuperation du salon Essort');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verrou par tableau : deux clics rapprochés ne doivent pas lire Airtable et
// créer les mêmes tâches deux fois.
// ---------------------------------------------------------------------------

const boardLocks = new Map<number, Promise<unknown>>();

function withBoardLock<T>(boardId: number, fn: () => Promise<T>): Promise<T> {
  const previous = boardLocks.get(boardId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.catch(() => undefined);
  boardLocks.set(boardId, settled);
  void settled.then(() => {
    if (boardLocks.get(boardId) === settled) boardLocks.delete(boardId);
  });
  return run;
}

// ---------------------------------------------------------------------------
// Lecture d'Airtable
// ---------------------------------------------------------------------------

/** 3 essais sur ~40 s ; sur un clic, un seul : la personne attend. */
const SCHEDULED_READ_DELAYS = [0, 10_000, 30_000];

async function readAgenda(date: string, delays: number[]): Promise<Agenda | null> {
  for (const [attempt, delay] of delays.entries()) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return buildAgenda(await fetchLeads(), date);
    } catch (err) {
      logger.warn({ err, attempt }, 'lecture Airtable impossible');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tâches du jour
// ---------------------------------------------------------------------------

function nextPosition(tasks: EssortTaskRow[]): number {
  return tasks.length > 0 ? Math.max(...tasks.map((t) => t.position)) + 1 : 0;
}

/**
 * Aligne les tâches Airtable du tableau sur l'agenda lu :
 *  - une action échue apparaît, une seule fois par lead et par action ;
 *  - une action déjà apparue un autre jour (faite, retirée, ou laissée sans
 *    report le soir) ne revient pas tant que sa date ou son action ne
 *    changent pas dans Airtable : rien ne passe au lendemain sans qu'on l'ait
 *    demandé à 19h ;
 *  - une tâche non faite dont le lead n'est plus dû (date repoussée, lead
 *    mort) disparaît ;
 *  - les tâches faites et les tâches manuelles ne sont jamais touchées.
 */
export async function reconcile(board: EssortBoardRow, agenda: Agenda | null): Promise<void> {
  if (!agenda) {
    await updateBoard(board.id, { extras: { ...board.extras, airtableError: true } });
    return;
  }

  const plan = agenda.people[board.person];
  // Retirées comprises : une action écartée ce matin ne revient pas à midi.
  const tasks = await listTasks(board.id, true);
  const history = await listAirtableTasksFor(plan.due.map((d) => d.recordId));
  const keep = new Set<number>();
  let position = nextPosition(tasks);

  for (const due of plan.due) {
    const onBoard = tasks.filter((t) => t.source === 'airtable' && t.record_id === due.recordId);

    const same = onBoard.find((t) => t.signature === due.signature);
    if (same) {
      keep.add(same.id);
      const open = !same.is_done && !same.dismissed_at;
      const changed =
        same.label !== due.label || same.details !== due.details || same.due_time !== due.time;
      if (open && changed) {
        await updateTask(same.id, { label: due.label, details: due.details, due_time: due.time });
      }
      continue;
    }

    if (history.some((t) => t.signature === due.signature && t.board_id !== board.id)) continue;

    // Même lead, autre action ou autre date : on met la tâche à jour sur place
    // plutôt que d'en empiler une seconde. Pas celle d'une autre étape du lead
    // encore due (la préparation d'un R2 le jour du R2).
    const stepSignatures = new Set(
      plan.due.filter((d) => d.recordId === due.recordId).map((d) => d.signature),
    );
    const pending = onBoard.find(
      (t) =>
        !t.is_done && !t.dismissed_at && !keep.has(t.id) && !stepSignatures.has(t.signature ?? ''),
    );
    if (pending) {
      keep.add(pending.id);
      await updateTask(pending.id, {
        signature: due.signature,
        label: due.label,
        details: due.details,
        due_time: due.time,
      });
      continue;
    }

    const added = await addTask({
      board_id: board.id,
      source: 'airtable',
      record_id: due.recordId,
      signature: due.signature,
      label: due.label,
      details: due.details,
      due_time: due.time,
      position: position++,
    });
    keep.add(added.id);
  }

  for (const t of tasks) {
    const open = !t.is_done && !t.dismissed_at;
    if (t.source === 'airtable' && open && !keep.has(t.id)) await deleteTask(t.id);
  }

  await updateBoard(board.id, {
    extras: { upcoming: plan.upcoming, airtableError: false },
    read_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Rappels (table `reminders`) : affichés dans le jour et la semaine
// ---------------------------------------------------------------------------

const PARIS_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function parisDateTime(d: Date): { date: string; time: string } {
  const p: Record<string, string> = {};
  for (const part of PARIS_PARTS.formatToParts(d)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function startOfDay(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return zonedWallClockToUtc({ year: year!, month: month!, day: day!, hour: 0, minute: 0 });
}

/** Occurrences des rappels de la personne entre deux jours inclus. */
async function reminderLines(
  userId: string | null,
  from: string,
  to: string,
): Promise<(TimedLine & { date: string })[]> {
  if (!userId) return [];
  const rows = (await listRemindersByUser(userId)).filter((r) => r.status !== 'done');
  const end = new Date(startOfDay(addDays(to, 1)).getTime() - 1);
  return expandOccurrences(rows, startOfDay(from), end).map((o) => ({
    ...parisDateTime(o.date),
    label: o.reminder.message,
  }));
}

// ---------------------------------------------------------------------------
// Les deux messages : la semaine, puis la journée
// ---------------------------------------------------------------------------

/** Code d'erreur Discord d'un message qui n'existe plus. */
const UNKNOWN_MESSAGE = 10008;

type MessagePayload = Pick<BaseMessageOptions, 'content' | 'embeds' | 'components'>;

/**
 * Met à jour un message, ou le publie s'il n'existe pas (encore ou plus).
 * Une simple erreur réseau ne doit pas doubler le message : seul un message
 * supprimé (10008) justifie de republier.
 */
async function upsertMessage(
  channel: SendableChannels,
  messageId: string | null,
  payload: MessagePayload,
  mentionUserIds: string[],
  allowPost: boolean,
): Promise<string | null> {
  if (messageId) {
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({ ...payload, allowedMentions: { parse: [] } });
      return messageId;
    } catch (err) {
      logger.warn({ err, messageId }, 'message Essort non modifiable');
      if ((err as { code?: unknown }).code !== UNKNOWN_MESSAGE) return messageId;
    }
  }
  if (!allowPost) return null;
  const sent = await channel.send({ ...payload, allowedMentions: { users: mentionUserIds } });
  return sent.id;
}

async function weekItems(board: EssortBoardRow): Promise<{ items: WeekItem[]; planned: number }> {
  const from = addDays(board.board_date, 1);
  const to = addDays(board.board_date, WEEK_DAYS);
  const items: WeekItem[] = (board.extras?.upcoming ?? []).map((u) => ({ ...u, kind: 'airtable' }));

  // Toutes les tâches planifiées à venir : le menu « Retirer » va au-delà de la semaine.
  const planned = await listPlannedTasks(board.person, from, '9999-12-31');
  for (const t of planned) {
    const date = t.essort_boards.board_date;
    if (date <= to) items.push({ date, time: t.due_time, label: t.label, kind: 'planned' });
  }
  for (const r of await reminderLines(memberOf(board.person)?.userId ?? null, from, to)) {
    items.push({ date: r.date, time: r.time, label: r.label, kind: 'reminder' });
  }
  return { items, planned: planned.length };
}

/** Publie ou met à jour les messages du tableau (semaine d'abord, puis jour). */
export async function renderBoard(
  client: Client,
  boardId: number,
  parts: { week?: boolean; day?: boolean } = {},
): Promise<void> {
  const board = await getBoardById(boardId);
  if (!board) return;
  const channel = await fetchChannel(client, board.channel_id);
  if (!channel) return;
  const live = !board.archived_at;
  const userId = memberOf(board.person)?.userId ?? null;

  if (parts.week !== false) {
    const { items, planned } = await weekItems(board);
    const id = await upsertMessage(
      channel,
      board.week_message_id,
      { embeds: [buildWeekEmbed(board, items)], components: buildWeekComponents(board, planned) },
      [],
      live,
    );
    if (id !== board.week_message_id) await updateBoard(board.id, { week_message_id: id });
  }

  if (parts.day !== false) {
    const tasks = dayOrder(await listTasks(board.id));
    const remaining = tasks.filter((t) => !t.is_done).length;
    const reminders = await reminderLines(userId, board.board_date, board.board_date);
    const id = await upsertMessage(
      channel,
      board.message_id,
      {
        content: live ? dayIntro(userId ? userMention(userId) : null, remaining, tasks.length) : '',
        embeds: [buildDayEmbed(board, tasks, reminders)],
        components: buildDayComponents(board, tasks),
      },
      userId ? [userId] : [],
      live,
    );
    if (id !== board.message_id) await updateBoard(board.id, { message_id: id });
  }
}

/**
 * Fige les tableaux des jours passés : plus de boutons. Les tâches non faites
 * y restent affichées telles quelles ; une question du soir restée sans
 * réponse est close.
 */
async function archivePastBoards(
  client: Client,
  person: EssortPerson,
  date: string,
): Promise<void> {
  for (const old of await listBoardsToArchive(person, date)) {
    await updateBoard(old.id, { archived_at: new Date().toISOString() });
    if (old.message_id || old.week_message_id) await renderBoard(client, old.id);
    if (old.evening_message_id && !old.evening_answered_at) {
      await closeEveningQuestion(client, old, 'Sans réponse : rien n’a été reporté.');
    }
  }
}

/**
 * Un message du jour posté sans message de semaine (version précédente du
 * bot) : on le remplace pour que la semaine passe au-dessus, dans l'ordre.
 */
async function replaceLoneDayMessage(client: Client, board: EssortBoardRow): Promise<void> {
  if (board.week_message_id || !board.message_id || board.archived_at) return;
  const channel = await fetchChannel(client, board.channel_id);
  if (channel) {
    await channel.messages
      .delete(board.message_id)
      .catch((err) => logger.warn({ err, id: board.id }, 'ancien message du jour non supprime'));
  }
  await updateBoard(board.id, { message_id: null });
}

async function publishBoard(
  client: Client,
  member: EssortMember,
  date: string,
  agenda: Agenda | null,
): Promise<void> {
  const { board } = await ensureBoard(member.person, date, member.channelId);
  await withBoardLock(board.id, async () => {
    // Les tableaux passés sont figés (sans boutons), puis Airtable ajoute ce
    // qui est dû. Rien n'est repris de la veille : seul ce qui a été reporté
    // à 19h est déjà sur le tableau du jour.
    await archivePastBoards(client, member.person, date);
    await reconcile(board, agenda);
    await replaceLoneDayMessage(client, board);
    await renderBoard(client, board.id);
    await schedulePings(client, board.id);
  });
  logger.info({ person: member.person, date, board: board.id }, 'tableau Essort publie');
}

/**
 * Rendez-vous de 6h, relectures de la journée et démarrage : un tableau par
 * personne. Publier un tableau déjà posté le met simplement à jour, sans
 * nouvelle mention.
 */
export async function publishBoards(client: Client): Promise<void> {
  const date = essortToday();
  const agenda = await readAgenda(date, SCHEDULED_READ_DELAYS);
  const failures: unknown[] = [];
  for (const m of essortMembers) {
    try {
      await publishBoard(client, m, date, agenda);
    } catch (err) {
      logger.error({ err, person: m.person }, 'echec de publication du tableau Essort');
      failures.push(err);
    }
  }
  void syncDoneTasks();
  // Remonter l'échec permet au rattrapage de réessayer (base en train de revenir…).
  if (failures.length > 0) throw failures[0];
}

/** Un rappel créé, modifié ou supprimé : le jour et la semaine de la personne suivent. */
export async function refreshForUser(client: Client, userId: string): Promise<void> {
  const member = essortMembers.find((m) => m.userId === userId);
  if (!member) return;
  const board = await getBoard(member.person, essortToday());
  if (!board?.message_id) return;
  await withBoardLock(board.id, () => renderBoard(client, board.id));
}

// ---------------------------------------------------------------------------
// Actions depuis Discord
// ---------------------------------------------------------------------------

export function refreshBoard(client: Client, board: EssortBoardRow): Promise<void> {
  return withBoardLock(board.id, async () => {
    const fresh = (await getBoardById(board.id)) ?? board;
    await reconcile(fresh, await readAgenda(fresh.board_date, [0]));
    await renderBoard(client, board.id);
    await schedulePings(client, board.id);
  });
}

/**
 * Ajoute une tâche à un jour (aujourd'hui ou plus tard) pour la personne du
 * tableau. Un jour à venir a son propre tableau, publié le matin venu.
 */
export async function planTask(
  client: Client,
  todayBoard: EssortBoardRow,
  date: string,
  label: string,
  time: string | null,
): Promise<void> {
  const isToday = date === todayBoard.board_date;
  const target = isToday
    ? todayBoard
    : (await ensureBoard(todayBoard.person, date, todayBoard.channel_id)).board;
  await withBoardLock(target.id, async () => {
    const tasks = await listTasks(target.id, true);
    await addTask({
      board_id: target.id,
      source: 'manual',
      label,
      due_time: time,
      position: nextPosition(tasks),
    });
  });
  await withBoardLock(todayBoard.id, async () => {
    await renderBoard(client, todayBoard.id, { week: !isToday, day: isToday });
    if (isToday) await schedulePings(client, todayBoard.id);
  });
  logger.info({ person: todayBoard.person, date, time, label }, 'tache Essort planifiee');
}

/**
 * Retire une tâche. Une tâche ajoutée à la main est supprimée ; une tâche
 * Airtable est seulement masquée, pour ne pas revenir aux relectures tant que
 * l'action ou la date du lead ne changent pas. Une ligne déjà écrite dans le
 * Sheet est effacée.
 */
async function dismissTask(task: EssortTaskRow): Promise<void> {
  // Décochée avant tout : plus aucune synchro ne la recopiera dans le Sheet.
  await updateTask(task.id, {
    is_done: false,
    done_at: null,
    done_by: null,
    dismissed_at: new Date().toISOString(),
  });
  await removeFromSheet(task.id);
  if (task.source === 'manual') await deleteTask(task.id);
}

/** Retire des tâches du jour et renvoie leurs libellés. */
export function removeTasks(
  client: Client,
  board: EssortBoardRow,
  taskIds: number[],
): Promise<string[]> {
  return withBoardLock(board.id, async () => {
    const removed: string[] = [];
    for (const id of taskIds) {
      const task = await getTask(id);
      if (!task || task.board_id !== board.id || task.dismissed_at) continue;
      await dismissTask(task);
      removed.push(task.label);
    }
    if (removed.length > 0) await renderBoard(client, board.id, { week: false });
    return removed;
  });
}

/** Retire des tâches posées sur des jours à venir (planifiées ou reportées). */
export function unplanTasks(
  client: Client,
  todayBoard: EssortBoardRow,
  taskIds: number[],
): Promise<string[]> {
  return withBoardLock(todayBoard.id, async () => {
    const removed: string[] = [];
    for (const id of taskIds) {
      const task = await getTask(id);
      if (!task || task.dismissed_at) continue;
      const board = await getBoardById(task.board_id);
      if (!board || board.person !== todayBoard.person) continue;
      if (board.board_date <= todayBoard.board_date) continue;
      await dismissTask(task);
      removed.push(task.label);
    }
    if (removed.length > 0) await renderBoard(client, todayBoard.id, { day: false });
    return removed;
  });
}

export function toggleTasks(
  client: Client,
  board: EssortBoardRow,
  taskIds: number[],
  doneBy: string,
): Promise<void> {
  return withBoardLock(board.id, async () => {
    for (const id of taskIds) {
      const task = await getTask(id);
      if (!task || task.board_id !== board.id) continue;
      const done = !task.is_done;
      await updateTask(task.id, {
        is_done: done,
        done_at: done ? new Date().toISOString() : null,
        done_by: done ? doneBy : null,
      });
      if (!done) void removeFromSheet(task.id);
    }
    await renderBoard(client, board.id, { week: false });
    void syncDoneTasks();
  });
}

// ---------------------------------------------------------------------------
// 19h : « Reporter à demain ? »
// ---------------------------------------------------------------------------

/**
 * Pour chaque personne qui a encore des tâches non faites, demande lesquelles
 * passer au lendemain. Une seule question par jour, même après un
 * redémarrage ; rien à demander si tout est fait.
 */
export async function askCarryOver(client: Client): Promise<void> {
  const date = essortToday();
  const failures: unknown[] = [];
  for (const m of essortMembers) {
    try {
      const board = await getBoard(m.person, date);
      if (!board || board.archived_at || board.evening_message_id) continue;
      await withBoardLock(board.id, async () => {
        const open = dayOrder(await listTasks(board.id)).filter((t) => !t.is_done);
        if (open.length === 0) return;
        const channel = await fetchChannel(client, board.channel_id);
        if (!channel) return;
        const userId = m.userId;
        const sent = await channel.send({
          ...buildEveningMessage(board, open, userId ? userMention(userId) : null),
          allowedMentions: { users: userId ? [userId] : [] },
        });
        await updateBoard(board.id, { evening_message_id: sent.id });
        logger.info({ person: m.person, open: open.length }, 'question du soir posee');
      });
    } catch (err) {
      logger.error({ err, person: m.person }, 'question du soir non posee');
      failures.push(err);
    }
  }
  if (failures.length > 0) throw failures[0];
}

/**
 * Passe les tâches choisies sur le tableau du lendemain (la même ligne, qui
 * sonnera de nouveau à son heure) et renvoie leurs libellés. Les autres
 * restent sur le jour, non faites.
 */
export function carryOver(
  client: Client,
  board: EssortBoardRow,
  taskIds: number[],
): Promise<string[]> {
  return withBoardLock(board.id, async () => {
    const tomorrow = addDays(board.board_date, 1);
    const { board: target } = await ensureBoard(board.person, tomorrow, board.channel_id);
    let position = nextPosition(await listTasks(target.id, true));
    const carried: string[] = [];
    for (const id of taskIds) {
      const task = await getTask(id);
      if (!task || task.board_id !== board.id || task.is_done || task.dismissed_at) continue;
      await moveTask(task.id, target.id, position++);
      if (task.pinged_at) await updateTask(task.id, { pinged_at: null });
      carried.push(task.label);
    }
    await updateBoard(board.id, { evening_answered_at: new Date().toISOString() });
    // Le jour perd les tâches reportées, la semaine les montre demain.
    if (carried.length > 0) await renderBoard(client, board.id);
    logger.info({ person: board.person, carried }, 'taches reportees au lendemain');
    return carried;
  });
}

/** Tâches encore ouvertes du tableau, pour « Tout reporter ». */
export async function openTaskIds(board: EssortBoardRow): Promise<number[]> {
  return (await listTasks(board.id)).filter((t) => !t.is_done).map((t) => t.id);
}

/** « Ne rien reporter » : la question est close, les tâches restent sur le jour. */
export async function declineCarryOver(board: EssortBoardRow): Promise<void> {
  await updateBoard(board.id, { evening_answered_at: new Date().toISOString() });
  logger.info({ person: board.person }, 'rien reporte au lendemain');
}

async function closeEveningQuestion(
  client: Client,
  board: EssortBoardRow,
  text: string,
): Promise<void> {
  const channel = await fetchChannel(client, board.channel_id);
  if (!channel || !board.evening_message_id) return;
  try {
    const msg = await channel.messages.fetch(board.evening_message_id);
    await msg.edit({ content: text, embeds: [], components: [], allowedMentions: { parse: [] } });
  } catch (err) {
    logger.warn({ err, id: board.id }, 'question du soir non close');
  }
}

// ---------------------------------------------------------------------------
// Pings à l'heure : « ⏰ 11:00 · Appeler… »
// ---------------------------------------------------------------------------

/** Un ping manqué de peu (redémarrage) part quand même ; au-delà, on s'abstient. */
const LATE_PING_MS = 5 * 60_000;
const pingTimers = new Map<number, NodeJS.Timeout>();

/** Programme le ping de chaque tâche à heure fixe du tableau du jour. */
export async function schedulePings(client: Client, boardId: number): Promise<void> {
  const board = await getBoardById(boardId);
  if (!board || board.archived_at || board.board_date !== essortToday()) return;
  const [year, month, day] = board.board_date.split('-').map(Number);

  for (const t of await listTasks(board.id)) {
    if (!t.due_time || t.is_done || t.pinged_at) continue;
    const [hour, minute] = t.due_time.split(':').map(Number);
    const at = zonedWallClockToUtc({
      year: year!,
      month: month!,
      day: day!,
      hour: hour!,
      minute: minute!,
    });
    const delay = at.getTime() - Date.now();
    if (delay < -LATE_PING_MS) continue;

    const previous = pingTimers.get(t.id);
    if (previous) clearTimeout(previous);
    pingTimers.set(
      t.id,
      setTimeout(
        () => {
          void firePing(client, t.id).catch((err) =>
            logger.error({ err, taskId: t.id }, 'ping Essort non envoye'),
          );
        },
        Math.max(0, delay),
      ),
    );
  }
}

async function firePing(client: Client, taskId: number): Promise<void> {
  pingTimers.delete(taskId);
  // On relit tout : la tâche a pu être faite, retirée ou déplacée entre-temps.
  const task = await getTask(taskId);
  if (!task?.due_time || task.is_done || task.dismissed_at || task.pinged_at) return;
  const board = await getBoardById(task.board_id);
  if (!board || board.archived_at || board.board_date !== essortToday()) return;
  const channel = await fetchChannel(client, board.channel_id);
  if (!channel) return;

  const userId = memberOf(board.person)?.userId ?? null;
  await channel.send({
    content: `⏰ ${userId ? `${userMention(userId)} ` : ''}**${task.due_time}** · ${task.label}`,
    allowedMentions: { users: userId ? [userId] : [] },
  });
  await updateTask(task.id, { pinged_at: new Date().toISOString() });
}

/** Au démarrage : reprogrammer les pings du jour (les minuteurs ne survivent pas). */
export async function restoreTodayPings(client: Client): Promise<void> {
  const date = essortToday();
  for (const m of essortMembers) {
    const board = await getBoard(m.person, date);
    if (board) await schedulePings(client, board.id);
  }
}

// ---------------------------------------------------------------------------
// Google Sheet : onglet « Essort », une ligne par tâche validée
// ---------------------------------------------------------------------------

const SHEET_TAB = 'Essort';
const SHEET_HEADER = [
  'Date',
  'Jour',
  'Personne',
  'Tâche',
  'Origine',
  'Faite à',
  'Validée par',
  'Fiche Airtable',
];
/** Ligne écrite mais plage non renvoyée par Google : on ne saura pas l'effacer. */
const UNKNOWN_RANGE = '?';

// Une seule écriture à la fois : une validation suivie d'une annulation
// rapide doit écrire puis effacer, jamais l'inverse.
let sheetQueue: Promise<void> = Promise.resolve();

function inSheetQueue(fn: () => Promise<void>): Promise<void> {
  const run = sheetQueue.then(fn);
  sheetQueue = run.catch(() => undefined);
  return run;
}

function taskToRow(task: TaskWithBoard): string[] {
  const date = task.essort_boards.board_date;
  return [
    date,
    formatPlanDate(date).split(' ')[0] ?? '',
    task.essort_boards.person,
    task.due_time ? `${task.due_time} · ${task.label}` : task.label,
    task.source === 'airtable' ? 'Airtable' : 'Ajoutée',
    task.done_at
      ? new Date(task.done_at).toLocaleTimeString('fr-FR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: config.TIMEZONE,
        })
      : '',
    task.done_by ?? '',
    task.record_id ? recordUrl(task.record_id) : '',
  ];
}

/**
 * Recopie dans le Sheet toutes les tâches faites qui n'y sont pas encore.
 * En cas d'échec, elles restent marquées et repartent au prochain passage.
 */
export function syncDoneTasks(): Promise<void> {
  return inSheetQueue(async () => {
    if (!isSheetsConfigured()) return;
    for (const task of await listTasksToSync()) {
      const range = await appendRowsTo(SHEET_TAB, SHEET_HEADER, [taskToRow(task)]);
      await updateTask(task.id, { sheet_range: range ?? UNKNOWN_RANGE });
    }
  }).catch((err) => logger.error({ err }, 'echec ecriture Google Sheets (Essort)'));
}

/** Une tâche décochée ou retirée : on vide sa ligne dans le Sheet. */
function removeFromSheet(taskId: number): Promise<void> {
  return inSheetQueue(async () => {
    const task = await getTask(taskId);
    if (!task || task.is_done || !task.sheet_range) return;
    if (task.sheet_range !== UNKNOWN_RANGE) await clearRange(task.sheet_range);
    await updateTask(task.id, { sheet_range: null });
  }).catch((err) => logger.error({ err, taskId }, 'echec effacement Google Sheets (Essort)'));
}
