import { Client, userMention, type BaseMessageOptions, type SendableChannels } from 'discord.js';
import { config, essortMembers, type EssortMember, type EssortPerson } from '../config';
import { logger } from '../logger';
import {
  addSpan,
  addTask,
  deleteTask,
  ensureBoard,
  getBoard,
  getBoardById,
  getSpan,
  getTask,
  listBoardsToArchive,
  listAirtableTasksFor,
  listCarriedFrom,
  listOpenSpans,
  listPlannedTasks,
  listSpanRows,
  listTasks,
  listTasksToSync,
  moveTask,
  updateBoard,
  updateSpan,
  updateTask,
  type EssortBoardRow,
  type EssortSpanRow,
  type EssortTaskRow,
  type SpanKind,
  type SpanPatch,
  type TaskWithBoard,
} from '../db/essortRepository';
import { listRemindersByUser } from '../db/repository';
import { formatPlanDate } from '../daily/ui';
import { parisDateValue, zonedWallClockToUtc } from '../lib/datetime';
import { expandOccurrences } from '../lib/embeds';
import { appendRowsTo, clearRange, isSheetsConfigured } from '../lib/sheets';
import { isCalendarConfigured } from '../lib/calendar';
import { buildCrmAgenda, fetchCrm, recordUrl } from './crm';
import { followInCalendar } from './calendarSync';
import {
  addDays,
  compareTime,
  duplicatesCrm,
  padDate,
  PEOPLE,
  pingPlan,
  restatesPastAction,
  untilText,
  WEEK_DAYS,
  type Agenda,
  type CrmAction,
} from './planner';
import {
  DEFAULT_END_TIME,
  isSpanOpen,
  spanClosedText,
  spanDetails,
  spanEnd,
  spanRowTime,
  spanShowsOn,
  spanWeekLines,
  type Moment,
} from './spans';
import {
  buildDayComponents,
  buildDayEmbed,
  buildEveningMessage,
  buildSpanQuestion,
  crmUpdateMessage,
  eveningSummary,
  type EveningItem,
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
// Verrou par tableau : deux clics rapprochés ne doivent pas lire le CRM et
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
// Lecture du CRM
// ---------------------------------------------------------------------------

/** 3 essais sur ~40 s ; sur un clic, un seul : la personne attend. */
const SCHEDULED_READ_DELAYS = [0, 10_000, 30_000];

/** Dernière lecture réussie du CRM pour aujourd'hui : l'agenda Google s'en sert après un clic. */
let lastAgenda: { date: string; agenda: Agenda } | null = null;

async function readAgenda(date: string, delays: number[]): Promise<Agenda | null> {
  for (const [attempt, delay] of delays.entries()) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const agenda = buildCrmAgenda(await fetchCrm(), date);
      if (date === essortToday()) lastAgenda = { date, agenda };
      return agenda;
    } catch (err) {
      logger.warn({ err, attempt }, 'lecture du CRM impossible');
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
 * Aligne les tâches du CRM sur le tableau (source `airtable` en base : nom
 * historique, d'avant le passage au CRM) :
 *  - une action échue apparaît, une seule fois par lead et par action ;
 *  - une action déjà apparue un autre jour (faite, retirée, ou laissée sans
 *    report le soir) ne revient pas tant que sa date ou son action ne
 *    changent pas dans le CRM : rien ne passe au lendemain sans qu'on l'ait
 *    demandé à 19h ;
 *  - une tâche non faite dont le lead n'est plus dû (date repoussée, fiche
 *    perdue, tâche faite dans le CRM) disparaît ;
 *  - les tâches faites et les tâches manuelles ne sont jamais touchées.
 */
export async function reconcile(board: EssortBoardRow, agenda: Agenda | null): Promise<void> {
  if (!agenda) {
    await updateBoard(board.id, { extras: { ...board.extras, crmError: true } });
    return;
  }

  const plan = agenda.people[board.person];
  // Retirées comprises : une action écartée ce matin ne revient pas à midi.
  const tasks = await listTasks(board.id, true);
  const history = await listAirtableTasksFor(plan.due.map((d) => d.recordId));
  const keep = new Set<number>();
  let position = nextPosition(tasks);
  // Ce que la personne a déjà écrit elle-même pour ce jour l'emporte : l'action
  // du CRM n'est pas ajoutée en double (et une copie déjà là est masquée).
  const manual = tasks.filter((t) => t.source === 'manual' && !t.dismissed_at);

  for (const due of plan.due) {
    const onBoard = tasks.filter((t) => t.source === 'airtable' && t.record_id === due.recordId);

    if (manual.some((m) => duplicatesCrm({ label: m.label, time: m.due_time }, due))) {
      // La tâche écrite tient lieu de l'action : on garde une trace masquée de
      // l'action pour ce jour, sinon elle reviendrait « en retard » le
      // lendemain si la tâche écrite n'est ni faite ni reportée.
      const copy = onBoard.find((t) => t.signature === due.signature);
      if (!copy) {
        const noted = await addTask({
          board_id: board.id,
          source: 'airtable',
          record_id: due.recordId,
          signature: due.signature,
          label: due.label,
          details: due.details,
          due_time: due.time,
          position: position++,
          dismissed_at: new Date().toISOString(),
        });
        keep.add(noted.id);
      } else {
        keep.add(copy.id);
        if (!copy.is_done && !copy.dismissed_at) {
          await updateTask(copy.id, { dismissed_at: new Date().toISOString() });
        }
      }
      continue;
    }

    const same = onBoard.find((t) => t.signature === due.signature);
    if (same) {
      keep.add(same.id);
      // Modifiée depuis Discord : la version de la personne l'emporte.
      const open = !same.is_done && !same.dismissed_at && !same.edited_at;
      const changed =
        same.label !== due.label || same.details !== due.details || same.due_time !== due.time;
      if (open && changed) {
        await updateTask(same.id, {
          label: due.label,
          details: due.details,
          due_time: due.time,
          ...(same.due_time !== due.time ? { pings_sent: 0 } : {}),
        });
      }
      continue;
    }

    if (history.some((t) => t.signature === due.signature && t.board_id !== board.id)) continue;

    // Seule l'Action a changé sur un jour passé déjà traité (« R2 » devenu
    // « Attente de doc ») : un statut, pas une chose à faire.
    const action = { recordId: due.recordId, signature: due.signature, date: due.dueDate };
    const before = history.filter((t) => t.board_id !== board.id);
    if (restatesPastAction(action, before, board.board_date)) continue;

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
        pings_sent: 0,
        edited_at: null,
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

  // Une tâche du CRM non faite disparaît quand son action n'est plus due ici
  // (date repoussée, lead mort)… sauf si cette action existe toujours dans le
  // CRM : c'est alors la personne qui l'a déplacée ici depuis Discord.
  const stillInCrm = new Set(plan.actions.map((a) => a.key));
  for (const t of tasks) {
    const open = !t.is_done && !t.dismissed_at;
    const movedHere = stillInCrm.has(`${t.record_id}|${t.signature}`);
    if (t.source === 'airtable' && open && !keep.has(t.id) && !movedHere) await deleteTask(t.id);
  }

  await updateBoard(board.id, {
    extras: { upcoming: plan.upcoming, crmError: false },
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

async function weekItems(
  board: EssortBoardRow,
): Promise<{ items: WeekItem[]; planned: number; crm: number; spans: number }> {
  const from = addDays(board.board_date, 1);
  const to = addDays(board.board_date, WEEK_DAYS);
  // Toutes les tâches planifiées à venir : le menu « Retirer » va au-delà de la semaine.
  const planned = await listPlannedTasks(board.person, from, '9999-12-31');
  const crm = await pendingCrmActions(board, planned);
  const items: WeekItem[] = crm.map((u) => ({
    date: u.date,
    time: u.time,
    label: u.label,
    kind: 'airtable' as const,
  }));
  for (const t of planned) {
    const date = t.essort_boards.board_date;
    if (date <= to) items.push({ date, time: t.due_time, label: t.label, kind: 'planned' });
  }
  for (const r of await reminderLines(memberOf(board.person)?.userId ?? null, from, to)) {
    items.push({ date: r.date, time: r.time, label: r.label, kind: 'reminder' });
  }
  const spans = await listOpenSpans(board.person);
  for (const span of spans) {
    for (const line of spanWeekLines(span, from, to)) items.push({ ...line, kind: 'planned' });
  }
  return {
    items,
    planned: planned.length,
    crm: crm.length,
    spans: spans.filter((s) => s.start_date >= from).length,
  };
}

type UpcomingAction = NonNullable<EssortBoardRow['extras']['upcoming']>[number];

/**
 * Les actions du CRM des jours à venir qui ne sont pas encore au planning :
 * ni déjà écrites à la main ce jour-là, ni déjà devenues une tâche (modifiée,
 * déplacée ou retirée depuis Discord).
 */
export async function pendingCrmActions(
  board: EssortBoardRow,
  planned?: TaskWithBoard[],
): Promise<UpcomingAction[]> {
  const upcoming = board.extras?.upcoming ?? [];
  const tasks =
    planned ?? (await listPlannedTasks(board.person, addDays(board.board_date, 1), '9999-12-31'));
  const recordIds = [...new Set(upcoming.map((u) => u.key?.split('|')[0]).filter(Boolean))];
  const taken = new Set(
    (await listAirtableTasksFor(recordIds as string[])).map((t) => `${t.record_id}|${t.signature}`),
  );
  return upcoming.filter(
    (u) =>
      !(u.key && taken.has(u.key)) &&
      !tasks.some(
        (t) =>
          t.source === 'manual' &&
          t.essort_boards.board_date === u.date &&
          duplicatesCrm({ label: t.label, time: t.due_time }, u),
      ),
  );
}

/**
 * Une action du CRM des jours à venir devient une tâche de son jour, pour
 * pouvoir être modifiée depuis Discord (heure, jour, texte). Renvoie la tâche
 * (déjà créée si on l'avait déjà fait), ou null si l'action n'existe plus.
 */
export async function crmActionAsTask(
  board: EssortBoardRow,
  key: string,
): Promise<{ task: EssortTaskRow; date: string } | null> {
  const fresh = (await getBoardById(board.id)) ?? board;
  const action = (fresh.extras?.upcoming ?? []).find((u) => u.key === key);
  if (!action) return null;
  const [recordId, ...rest] = key.split('|');
  const signature = rest.join('|');
  if (!recordId || !signature) return null;
  const existing = (await listAirtableTasksFor([recordId])).find(
    (t) => t.signature === signature && !t.dismissed_at,
  );
  const { board: target } = await ensureBoard(board.person, action.date, board.channel_id);
  if (existing) return { task: existing, date: target.board_date };
  const task = await addTask({
    board_id: target.id,
    source: 'airtable',
    record_id: recordId,
    signature,
    label: action.label,
    details: action.details ?? null,
    due_time: action.time,
    position: nextPosition(await listTasks(target.id, true)),
  });
  return { task, date: action.date };
}

/**
 * Les tâches du CRM posées sur les jours à venir (modifiées depuis Discord)
 * disparaissent quand le CRM change leur action ou leur date : le CRM reprend
 * la main, sa nouvelle action apparaît à la place.
 */
export async function pruneFutureCrmTasks(
  person: EssortPerson,
  today: string,
  agenda: Agenda,
): Promise<void> {
  const stillInCrm = new Set(agenda.people[person].actions.map((a) => a.key));
  const future = await listPlannedTasks(person, addDays(today, 1), '9999-12-31');
  for (const t of future) {
    if (t.source !== 'airtable' || t.is_done) continue;
    if (!stillInCrm.has(`${t.record_id}|${t.signature}`)) await deleteTask(t.id);
  }
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
    const { items, planned, crm, spans } = await weekItems(board);
    const id = await upsertMessage(
      channel,
      board.week_message_id,
      {
        embeds: [buildWeekEmbed(board, items)],
        components: buildWeekComponents(board, planned + spans, planned + crm + spans),
      },
      [],
      live,
    );
    if (id !== board.week_message_id) await updateBoard(board.id, { week_message_id: id });
  }

  if (parts.day !== false) {
    const tasks = dayOrder(await listTasks(board.id));
    const remaining = tasks.filter((t) => !t.is_done).length;
    const reminders = await reminderLines(userId, board.board_date, board.board_date);
    const carried = (await listCarriedFrom(board.id)).filter(
      (t) => t.board_id !== board.id && !t.is_done,
    );
    const id = await upsertMessage(
      channel,
      board.message_id,
      {
        content: live ? dayIntro(userId ? userMention(userId) : null, remaining, tasks.length) : '',
        embeds: [buildDayEmbed(board, tasks, reminders, carried)],
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
    if (old.evening_message_id && !old.evening_answered_at) await finishEvening(client, old, null);
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
    // Les tableaux passés sont figés (sans boutons), puis le CRM ajoute ce
    // qui est dû. Rien n'est repris de la veille : seul ce qui a été reporté
    // à 19h est déjà sur le tableau du jour.
    await archivePastBoards(client, member.person, date);
    await reconcile(board, agenda);
    await placeSpans(board);
    if (agenda) await pruneFutureCrmTasks(member.person, date, agenda);
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
  if (agenda) void followInCalendar(agenda, date);
  // Remonter l'échec permet au rattrapage de réessayer (base en train de revenir…).
  if (failures.length > 0) throw failures[0];
}

// ---------------------------------------------------------------------------
// Synchro continue avec le CRM
// ---------------------------------------------------------------------------

/** Dernier agenda lu par personne : ce qui a changé depuis mérite d'être dit. */
const lastSeen = new Map<EssortPerson, { fingerprint: string; actions: Map<string, CrmAction> }>();

/** Actions nouvelles, ou dont le jour, l'heure ou l'intitulé ont changé. */
export function changedActions(previous: Map<string, CrmAction>, next: CrmAction[]): CrmAction[] {
  return next.filter((a) => {
    const before = previous.get(a.key);
    return !before || before.date !== a.date || before.time !== a.time || before.label !== a.label;
  });
}

/**
 * Ce que montrent les deux messages d'un tableau, lu en base : les tâches du
 * jour et des 6 suivants. Une tâche posée ou changée par une autre voie que
 * le bot (une autre session, un script) change cette empreinte.
 */
async function boardState(board: EssortBoardRow): Promise<string> {
  const tasks = await listPlannedTasks(
    board.person,
    board.board_date,
    addDays(board.board_date, WEEK_DAYS),
  );
  return JSON.stringify(
    tasks.map((t) => [
      t.id,
      t.essort_boards.board_date,
      t.label,
      t.details,
      t.due_time,
      t.is_done,
      t.position,
    ]),
  );
}

/** Dernière empreinte de chaque tableau, après sa dernière mise à jour par la synchro. */
const lastBoardState = new Map<number, string>();

/**
 * Relit le CRM toutes les 5 minutes. Pour chaque personne dont le tableau du
 * jour est déjà publié, et dont l'agenda du CRM ou les tâches en base ont
 * changé : met à jour ses deux messages (sans mention) et reprogramme les
 * pings, puis dit en une ligne ce que le bot a compris des actions du CRM
 * ajoutées ou déplacées. Une tâche du jour écrite en base apparaît et sonne
 * ainsi sans « 🔄 Actualiser ». Avant 6h, rien n'est publié : le tableau du
 * jour sera construit à l'heure, avec ces changements.
 */
export async function syncFromCrm(client: Client): Promise<void> {
  const date = essortToday();
  const agenda = await readAgenda(date, [0]);
  // CRM injoignable : la prochaine synchro réessaiera.
  if (!agenda) return;

  for (const m of essortMembers) {
    try {
      const plan = agenda.people[m.person];
      const fingerprint = JSON.stringify(plan);
      const previous = lastSeen.get(m.person);
      const crmChanged = previous?.fingerprint !== fingerprint;

      const board = await getBoard(m.person, date);
      if (!board?.message_id || board.archived_at) continue;
      const tasksChanged = lastBoardState.get(board.id) !== (await boardState(board));
      if (!crmChanged && !tasksChanged) continue;

      await withBoardLock(board.id, async () => {
        await reconcile((await getBoardById(board.id)) ?? board, agenda);
        await pruneFutureCrmTasks(m.person, date, agenda);
        await renderBoard(client, board.id);
        await schedulePings(client, board.id);
        // Une question du soir encore ouverte suit aussi : une tâche du jour
        // arrivée du CRM après 19h doit pouvoir être reportée.
        const fresh = await getBoardById(board.id);
        if (fresh?.evening_message_id && !fresh.evening_answered_at) {
          await renderEvening(client, fresh);
        }
        lastBoardState.set(board.id, await boardState(fresh ?? board));
      });
      if (!crmChanged) continue;

      // Au premier passage après un démarrage, rien à comparer : on retient.
      // Ce qui est déjà au planning (écrit à la main) n'est pas annoncé.
      const written = previous
        ? (await listPlannedTasks(m.person, date, '9999-12-31')).filter(
            (t) => t.source === 'manual',
          )
        : [];
      // Une action passée n'est jamais remise au tableau : elle ne s'annonce pas non plus.
      const candidates = (previous ? changedActions(previous.actions, plan.actions) : []).filter(
        (a) =>
          a.date >= date &&
          !written.some(
            (t) =>
              t.essort_boards.board_date === a.date &&
              duplicatesCrm({ label: t.label, time: t.due_time }, a),
          ),
      );
      // Un simple changement de statut sur un jour passé déjà traité ne s'annonce pas.
      const handled =
        candidates.length > 0
          ? await listAirtableTasksFor([...new Set(candidates.map((a) => a.key.split('|')[0]!))])
          : [];
      const changes = candidates.filter((a) => {
        const [recordId, ...rest] = a.key.split('|');
        const action = { recordId: recordId!, signature: rest.join('|'), date: a.date };
        return !restatesPastAction(action, handled, date);
      });
      lastSeen.set(m.person, {
        fingerprint,
        actions: new Map(plan.actions.map((a) => [a.key, a])),
      });
      if (changes.length > 0) {
        const channel = await fetchChannel(client, board.channel_id);
        await channel?.send({
          content: crmUpdateMessage(changes, date),
          allowedMentions: { parse: [] },
        });
        logger.info(
          { person: m.person, changes: changes.length },
          'agenda mis a jour depuis le CRM',
        );
      }
    } catch (err) {
      logger.error({ err, person: m.person }, 'synchro CRM en echec');
    }
  }
  // À chaque relecture, même sans changement : l'agenda se répare tout seul
  // (événement effacé à la main, écriture précédente en échec).
  void followInCalendar(agenda, date);
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

/**
 * Après un changement depuis Discord, l'agenda Google suit aussitôt, avec la
 * dernière lecture du CRM (5 minutes au plus). Ne bloque pas le clic.
 */
function calendarFollows(): void {
  if (!isCalendarConfigured()) return;
  const today = essortToday();
  void (async () => {
    const agenda = lastAgenda?.date === today ? lastAgenda.agenda : await readAgenda(today, [0]);
    if (agenda) await followInCalendar(agenda, today);
  })().catch((err) => logger.error({ err }, 'synchro agenda Google en echec'));
}

export function refreshBoard(client: Client, board: EssortBoardRow): Promise<void> {
  return withBoardLock(board.id, async () => {
    const fresh = (await getBoardById(board.id)) ?? board;
    await reconcile(fresh, await readAgenda(fresh.board_date, [0]));
    await placeSpans(fresh);
    await renderBoard(client, board.id);
    await schedulePings(client, board.id);
    calendarFollows();
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
    if (isToday) {
      // Si la tâche écrite est déjà une action du CRM du jour, l'action en
      // double s'efface du tableau.
      const agenda = await readAgenda(todayBoard.board_date, [0]);
      if (agenda) await reconcile((await getBoardById(todayBoard.id)) ?? todayBoard, agenda);
    }
    await renderBoard(client, todayBoard.id, { week: !isToday, day: isToday });
    if (isToday) await schedulePings(client, todayBoard.id);
    if (isToday) await refreshEveningIfOpen(client, todayBoard.id);
  });
  calendarFollows();
  logger.info({ person: todayBoard.person, date, time, label }, 'tache Essort planifiee');
}

/**
 * Modifie une tâche (texte, jour, heure) et renvoie son nouvel intitulé, ou
 * null si elle n'existe plus. Changer de jour la déplace sur le tableau de ce
 * jour ; changer d'heure reprogramme ses pings. Une tâche venue du CRM garde
 * la modification tant que l'action ou sa date ne changent pas dans le CRM.
 */
export function editTask(
  client: Client,
  todayBoard: EssortBoardRow,
  taskId: number,
  change: { label: string; date: string; time: string | null },
): Promise<string | null> {
  return withBoardLock(todayBoard.id, async () => {
    const task = await getTask(taskId);
    // Une tâche permanente ou une période se modifie entière (`editSpan`).
    if (!task || task.dismissed_at || task.is_done || task.span_id) return null;
    const from = await getBoardById(task.board_id);
    if (!from || from.person !== todayBoard.person) return null;

    if (change.date !== from.board_date) {
      const { board: target } = await ensureBoard(
        todayBoard.person,
        change.date,
        todayBoard.channel_id,
      );
      await moveTask(task.id, target.id, nextPosition(await listTasks(target.id, true)), null);
    }
    const timeChanged = change.time !== task.due_time || change.date !== from.board_date;
    await updateTask(task.id, {
      label: change.label,
      due_time: change.time,
      ...(timeChanged ? { pings_sent: 0 } : {}),
      ...(task.source === 'airtable' ? { edited_at: new Date().toISOString() } : {}),
    });

    // Le jour et la semaine peuvent changer tous les deux (déplacement).
    await renderBoard(client, todayBoard.id);
    await schedulePings(client, todayBoard.id);
    await refreshEveningIfOpen(client, todayBoard.id);
    calendarFollows();
    logger.info({ person: todayBoard.person, taskId, ...change }, 'tache Essort modifiee');
    return change.label;
  });
}

/**
 * Retire une tâche. Une tâche ajoutée à la main est supprimée ; une tâche
 * du CRM est seulement masquée, pour ne pas revenir aux relectures tant que
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
export async function removeTasks(
  client: Client,
  board: EssortBoardRow,
  taskIds: number[],
): Promise<string[]> {
  const dropped: EssortSpanRow[] = [];
  const removed = await withBoardLock(board.id, async () => {
    const labels: string[] = [];
    for (const id of taskIds) {
      const task = await getTask(id);
      if (!task || task.board_id !== board.id || task.dismissed_at) continue;
      await dismissTask(task);
      // Retirée pour de bon : elle ne revient pas les jours suivants (ni
      // chez l'autre, pour une tâche de toute l'équipe).
      const span = task.span_id ? await getSpan(task.span_id) : null;
      if (span && isSpanOpen(span)) {
        await dropSpan(client, span, null);
        dropped.push(span);
      }
      labels.push(task.label);
    }
    if (labels.length > 0) {
      await renderBoard(client, board.id, { week: false });
      await refreshEveningIfOpen(client, board.id);
      calendarFollows();
    }
    return labels;
  });
  await refreshSharedBoards(client, dropped, board.id);
  return removed;
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
    if (removed.length > 0) {
      await renderBoard(client, todayBoard.id, { day: false });
      calendarFollows();
    }
    return removed;
  });
}

export async function toggleTasks(
  client: Client,
  board: EssortBoardRow,
  taskIds: number[],
  doneBy: string,
): Promise<void> {
  const spans: EssortSpanRow[] = [];
  await withBoardLock(board.id, async () => {
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
      const span = task.span_id ? await spanRowToggled(client, task.span_id, done, doneBy) : null;
      if (span) spans.push(span);
    }
    await renderBoard(client, board.id, { week: false });
    await refreshEveningIfOpen(client, board.id);
    void syncDoneTasks();
  });
  // Une tâche de toute l'équipe cochée part du tableau de l'autre (et revient si décochée).
  await refreshSharedBoards(client, spans, board.id);
}

// ---------------------------------------------------------------------------
// 19h : « Reporter à demain ? »
// ---------------------------------------------------------------------------

/**
 * Les tâches de la question du soir : celles encore ouvertes sur le jour, et
 * celles déjà reportées ce soir (pour pouvoir annuler). Ordre stable : un
 * report ne doit pas renuméroter les boutons.
 */
async function eveningItems(board: EssortBoardRow): Promise<EveningItem[]> {
  // Une tâche permanente revient seule demain ; une période a sa propre question.
  const open = (await listTasks(board.id)).filter((t) => !t.is_done && !t.span_id);
  const carried = (await listCarriedFrom(board.id)).filter(
    (t) => t.board_id !== board.id && !t.is_done,
  );
  return [
    ...open.map((task) => ({ task, carried: false })),
    ...carried.map((task) => ({ task, carried: true })),
  ].sort((a, b) => compareTime(a.task.due_time, b.task.due_time) || a.task.id - b.task.id);
}

/** Publie la question (avec mention) ou la met à jour (sans nouvelle mention). */
async function renderEvening(client: Client, board: EssortBoardRow): Promise<void> {
  const items = await eveningItems(board);
  if (items.length === 0 && !board.evening_message_id) return;
  const channel = await fetchChannel(client, board.channel_id);
  if (!channel) return;
  const userId = memberOf(board.person)?.userId ?? null;
  // Tout a été coché après la question : plus rien à reporter.
  const payload =
    items.length === 0
      ? { content: 'Tout est fait aujourd’hui. ✅', embeds: [], components: [] }
      : buildEveningMessage(board, items, userId ? userMention(userId) : null);
  const id = await upsertMessage(
    channel,
    board.evening_message_id,
    payload,
    userId ? [userId] : [],
    !board.archived_at && items.length > 0,
  );
  if (id !== board.evening_message_id) await updateBoard(board.id, { evening_message_id: id });
}

/**
 * La question du soir suit le tableau : une tâche cochée, ajoutée, modifiée ou
 * retirée après 19h y apparaît ou en disparaît aussitôt.
 */
async function refreshEveningIfOpen(client: Client, boardId: number): Promise<void> {
  const board = await getBoardById(boardId);
  if (board?.evening_message_id && !board.evening_answered_at && !board.archived_at) {
    await renderEvening(client, board);
  }
}

/**
 * Pour chaque personne qui a encore des tâches non faites, demande lesquelles
 * passer au lendemain. Une seule question par jour ; après un redémarrage, une
 * question encore ouverte est simplement remise à jour.
 */
export async function askCarryOver(client: Client): Promise<void> {
  const date = essortToday();
  const failures: unknown[] = [];
  for (const m of essortMembers) {
    try {
      const board = await getBoard(m.person, date);
      if (!board || board.archived_at || board.evening_answered_at) continue;
      await withBoardLock(board.id, async () => {
        const fresh = (await getBoardById(board.id)) ?? board;
        await renderEvening(client, fresh);
      });
      logger.info({ person: m.person }, 'question du soir posee');
    } catch (err) {
      logger.error({ err, person: m.person }, 'question du soir non posee');
      failures.push(err);
    }
  }
  if (failures.length > 0) throw failures[0];
}

/**
 * Un clic sur une tâche de la question du soir : encore sur le jour, elle
 * passe sur le tableau du lendemain (la même ligne, qui sonnera de nouveau à
 * son heure) ; déjà reportée, elle revient sur le jour.
 */
export function toggleCarry(
  client: Client,
  board: EssortBoardRow,
  taskIds: number[],
): Promise<void> {
  return withBoardLock(board.id, async () => {
    const { board: tomorrow } = await ensureBoard(
      board.person,
      addDays(board.board_date, 1),
      board.channel_id,
    );
    for (const id of taskIds) {
      const task = await getTask(id);
      if (!task || task.is_done || task.dismissed_at || task.span_id) continue;
      if (task.board_id === board.id) {
        const position = nextPosition(await listTasks(tomorrow.id, true));
        await moveTask(task.id, tomorrow.id, position, board.id);
      } else if (task.carried_from === board.id && task.board_id === tomorrow.id) {
        const position = nextPosition(await listTasks(board.id, true));
        await moveTask(task.id, board.id, position, null);
      }
    }
    // Le jour perd ou retrouve la tâche, la semaine la montre demain.
    await renderBoard(client, board.id);
    await renderEvening(client, (await getBoardById(board.id)) ?? board);
    calendarFollows();
  });
}

/** « Tout reporter » : toutes les tâches encore sur le jour passent à demain. */
export async function carryAll(client: Client, board: EssortBoardRow, by: string): Promise<void> {
  const open = (await listTasks(board.id)).filter((t) => !t.is_done && !t.span_id).map((t) => t.id);
  await toggleCarry(client, board, open);
  await finishEvening(client, board, by);
}

/**
 * Clôt la question : le message ne garde que ce qui a été reporté.
 * @param by qui a répondu, ou null si personne (clôture du matin).
 */
export async function finishEvening(
  client: Client,
  board: EssortBoardRow,
  by: string | null,
): Promise<void> {
  const carried = (await listCarriedFrom(board.id)).filter((t) => t.board_id !== board.id);
  if (by) await updateBoard(board.id, { evening_answered_at: new Date().toISOString() });
  const channel = await fetchChannel(client, board.channel_id);
  if (channel && board.evening_message_id) {
    const summary = eveningSummary(
      carried.map((t) => t.label),
      by !== null,
    );
    try {
      const msg = await channel.messages.fetch(board.evening_message_id);
      await msg.edit({
        content: by ? `${summary} (${by})` : summary,
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      logger.warn({ err, id: board.id }, 'question du soir non close');
    }
  }
  logger.info({ person: board.person, carried: carried.length, by }, 'question du soir close');
}

// ---------------------------------------------------------------------------
// Pings avant l'heure : « ⏰ 14:00 (dans 30 min) · R2 avec… »
// ---------------------------------------------------------------------------

/** Minuteurs en cours, par tâche (un par ping restant). */
const pingTimers = new Map<number, NodeJS.Timeout[]>();

function startOf(date: string, time: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return zonedWallClockToUtc({
    year: year!,
    month: month!,
    day: day!,
    hour: hour!,
    minute: minute!,
  }).getTime();
}

/** Programme les pings (1 h, 30 min, 10 min avant) des tâches à heure fixe du jour. */
export async function schedulePings(client: Client, boardId: number): Promise<void> {
  const board = await getBoardById(boardId);
  if (!board || board.archived_at || board.board_date !== essortToday()) return;

  for (const t of await listTasks(board.id)) {
    for (const timer of pingTimers.get(t.id) ?? []) clearTimeout(timer);
    pingTimers.delete(t.id);
    if (!t.due_time || t.is_done) continue;

    const plan = pingPlan(startOf(board.board_date, t.due_time), t.pings_sent, Date.now());
    pingTimers.set(
      t.id,
      plan.map(({ index, delay }) =>
        setTimeout(() => {
          void firePing(client, t.id, index).catch((err) =>
            logger.error({ err, taskId: t.id, index }, 'ping Essort non envoye'),
          );
        }, delay),
      ),
    );
  }
}

async function firePing(client: Client, taskId: number, index: number): Promise<void> {
  // On relit tout : la tâche a pu être faite, retirée, déplacée ou changer
  // d'heure entre-temps.
  const task = await getTask(taskId);
  if (!task?.due_time || task.is_done || task.dismissed_at || task.pings_sent > index) return;
  const board = await getBoardById(task.board_id);
  if (!board || board.archived_at || board.board_date !== essortToday()) return;
  const start = startOf(board.board_date, task.due_time);
  const now = Date.now();
  if (start <= now) return;
  const channel = await fetchChannel(client, board.channel_id);
  if (!channel) return;

  const userId = memberOf(board.person)?.userId ?? null;
  await channel.send({
    content: `⏰ ${userId ? `${userMention(userId)} ` : ''}**${task.due_time}** (${untilText(start, now)}) · ${task.label}`,
    allowedMentions: { users: userId ? [userId] : [] },
  });
  await updateTask(task.id, { pings_sent: index + 1 });
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
// Tâches de tous les jours et tâches sur une période
// ---------------------------------------------------------------------------

/**
 * Pose sur le tableau la ligne du jour de chaque tâche permanente ou période
 * qui s'y affiche, et tient à jour celles déjà posées (texte, heure, échéance).
 * Une ligne cochée ou retirée n'est plus touchée ; celle d'une tâche faite ou
 * retirée ailleurs (par l'autre, pour une tâche de toute l'équipe) s'en va.
 */
export async function placeSpans(board: EssortBoardRow): Promise<void> {
  if (board.archived_at) return;
  const tasks = await listTasks(board.id, true);
  const spans = await listOpenSpans(board.person);
  const open = new Set(spans.map((s) => s.id));
  for (const row of tasks) {
    if (row.span_id && !open.has(row.span_id) && !row.is_done && !row.dismissed_at) {
      await deleteTask(row.id);
    }
  }
  let position = nextPosition(tasks);
  for (const span of spans) {
    const row = tasks.find((t) => t.span_id === span.id);
    const shows = spanShowsOn(span, board.board_date);
    const wanted = {
      label: span.label,
      details: spanDetails(span, board.board_date, board.person),
      due_time: spanRowTime(span, board.board_date),
    };
    if (!row) {
      if (shows) {
        await addTask({
          board_id: board.id,
          source: 'manual',
          span_id: span.id,
          position: position++,
          ...wanted,
        });
      }
    } else if (!row.is_done && !row.dismissed_at) {
      // Plus ce jour-ci (début repoussé) : la ligne s'en va.
      if (!shows) await deleteTask(row.id);
      else if (
        row.label !== wanted.label ||
        row.details !== wanted.details ||
        row.due_time !== wanted.due_time
      ) {
        await updateTask(row.id, {
          ...wanted,
          ...(row.due_time !== wanted.due_time ? { pings_sent: 0 } : {}),
        });
      }
    }
  }
}

/** Les personnes dont le tableau montre la tâche : toute l'équipe, ou la sienne. */
function spanPeople(span: EssortSpanRow): readonly EssortPerson[] {
  return span.shared ? PEOPLE : [span.person];
}

/**
 * Les tableaux du jour qui montrent la tâche suivent, s'ils sont publiés (sauf
 * `except`, déjà à jour). Jamais sous le verrou d'un autre tableau : deux
 * verrous pris l'un dans l'autre bloqueraient si Loys et Enzo cliquent ensemble.
 */
async function refreshSpanBoards(
  client: Client,
  span: EssortSpanRow,
  except: number | null = null,
): Promise<void> {
  for (const person of spanPeople(span)) {
    const board = await getBoard(person, essortToday());
    if (!board?.message_id || board.archived_at || board.id === except) continue;
    await withBoardLock(board.id, async () => {
      await placeSpans(board);
      await renderBoard(client, board.id);
      await schedulePings(client, board.id);
    });
  }
}

/** Après un clic : les autres tableaux qui montrent ces tâches de toute l'équipe suivent. */
async function refreshSharedBoards(
  client: Client,
  spans: EssortSpanRow[],
  except: number,
): Promise<void> {
  const seen = new Set<number>();
  for (const span of spans) {
    if (!span.shared || seen.has(span.id)) continue;
    seen.add(span.id);
    await refreshSpanBoards(client, span, except);
  }
}

/** Les périodes pas encore commencées : la semaine les montre, on peut les modifier ou les retirer. */
export async function futureSpans(board: EssortBoardRow): Promise<EssortSpanRow[]> {
  return (await listOpenSpans(board.person)).filter((s) => s.start_date > board.board_date);
}

/**
 * Crée une tâche permanente (dès aujourd'hui) ou une période pour la personne
 * du tableau, ou pour toute l'équipe (`shared`). Elle apparaît aussitôt si
 * elle commence aujourd'hui.
 */
export async function createSpan(
  client: Client,
  todayBoard: EssortBoardRow,
  input: { kind: SpanKind; shared?: boolean; label: string; start: Moment; end: Moment | null },
): Promise<EssortSpanRow> {
  const span = await addSpan({
    person: todayBoard.person,
    channel_id: todayBoard.channel_id,
    shared: input.shared ?? false,
    kind: input.kind,
    label: input.label,
    start_date: input.start.date,
    start_time: input.start.time,
    end_date: input.end?.date ?? null,
    end_time: input.end ? (input.end.time ?? DEFAULT_END_TIME) : null,
  });
  await withBoardLock(todayBoard.id, async () => {
    await placeSpans((await getBoardById(todayBoard.id)) ?? todayBoard);
    await renderBoard(client, todayBoard.id);
    await schedulePings(client, todayBoard.id);
  });
  await refreshSharedBoards(client, [span], todayBoard.id);
  logger.info(
    { person: span.person, span: span.id, kind: span.kind, shared: span.shared, label: span.label },
    'tache Essort sur plusieurs jours creee',
  );
  return span;
}

/**
 * Modifie une tâche permanente (texte) ou une période (texte, début, fin) et
 * renvoie la version enregistrée, ou null si elle est close ou n'existe plus.
 * Une fin déplacée après la question de fin la clôt comme un report.
 */
export async function editSpan(
  client: Client,
  todayBoard: EssortBoardRow,
  spanId: number,
  change: { label: string; start?: Moment; end?: Moment },
): Promise<EssortSpanRow | null> {
  const edited = await withBoardLock(todayBoard.id, async () => {
    const span = await getSpan(spanId);
    if (!span || !isSpanOpen(span) || !onBoardOf(span, todayBoard)) return null;
    const patch: SpanPatch = { label: change.label };
    if (span.kind === 'period' && change.start && change.end) {
      patch.start_date = change.start.date;
      patch.start_time = change.start.time;
      patch.end_date = change.end.date;
      patch.end_time = change.end.time ?? DEFAULT_END_TIME;
    }
    const endMoved =
      patch.end_date !== undefined &&
      (patch.end_date !== span.end_date || patch.end_time !== span.end_time);
    if (endMoved) Object.assign(patch, { asked_at: null, ask_message_id: null });
    const updated = await updateSpan(span.id, patch);
    if (!updated) return null;
    if (endMoved) await closeSpanQuestion(client, span, spanClosedText(updated, 'report', null));

    await placeSpans((await getBoardById(todayBoard.id)) ?? todayBoard);
    await renderBoard(client, todayBoard.id);
    await schedulePings(client, todayBoard.id);
    logger.info(
      { person: span.person, span: span.id, ...patch },
      'tache Essort sur plusieurs jours modifiee',
    );
    return updated;
  });
  if (edited) await refreshSharedBoards(client, [edited], todayBoard.id);
  return edited;
}

/** La tâche s'affiche-t-elle sur ce tableau (la sienne, ou une de toute l'équipe) ? */
function onBoardOf(span: EssortSpanRow, board: EssortBoardRow): boolean {
  return span.shared || span.person === board.person;
}

/** Retire des périodes pas encore commencées (menu « Retirer » de la semaine). */
export async function removeSpans(
  client: Client,
  todayBoard: EssortBoardRow,
  spanIds: number[],
): Promise<string[]> {
  const dropped: EssortSpanRow[] = [];
  await withBoardLock(todayBoard.id, async () => {
    for (const id of spanIds) {
      const span = await getSpan(id);
      if (!span || !isSpanOpen(span) || !onBoardOf(span, todayBoard)) continue;
      await dropSpan(client, span, null);
      dropped.push(span);
    }
    if (dropped.length > 0) await renderBoard(client, todayBoard.id);
  });
  await refreshSharedBoards(client, dropped, todayBoard.id);
  return dropped.map((s) => s.label);
}

/** Retire une tâche permanente ou une période : elle ne s'affiche plus nulle part. */
async function dropSpan(client: Client, span: EssortSpanRow, by: string | null): Promise<void> {
  await updateSpan(span.id, { dismissed_at: new Date().toISOString() });
  const today = essortToday();
  for (const row of await listSpanRows(span.id)) {
    if (!row.is_done && row.essort_boards.board_date >= today) await dismissTask(row);
  }
  await closeSpanQuestion(client, span, spanClosedText(span, 'drop', by));
}

/**
 * Sa ligne du jour cochée : la tâche entière est faite (elle ne revient plus,
 * sa question de fin se clôt). Décochée : elle est rouverte, et une période
 * déjà finie sera redemandée.
 */
async function spanRowToggled(
  client: Client,
  spanId: number,
  done: boolean,
  by: string,
): Promise<EssortSpanRow | null> {
  const span = await getSpan(spanId);
  if (!span || span.dismissed_at) return null;
  if (done) {
    await updateSpan(span.id, { done_at: new Date().toISOString(), done_by: by });
    await closeSpanQuestion(client, span, spanClosedText(span, 'done', by));
  } else {
    await updateSpan(span.id, {
      done_at: null,
      done_by: null,
      asked_at: null,
      ask_message_id: null,
    });
  }
  return span;
}

/** Clôt la question de fin de période : le message ne garde que la réponse. */
async function closeSpanQuestion(client: Client, span: EssortSpanRow, text: string): Promise<void> {
  if (!span.ask_message_id) return;
  const channel = await fetchChannel(client, span.channel_id);
  if (!channel) return;
  try {
    const msg = await channel.messages.fetch(span.ask_message_id);
    await msg.edit({ content: text, embeds: [], components: [], allowedMentions: { parse: [] } });
  } catch (err) {
    logger.warn({ err, span: span.id }, 'question de fin de periode non close');
  }
}

let askingSpans = false;

/**
 * Toutes les minutes : une période arrivée à sa fin, ni faite ni retirée,
 * reçoit sa question, une seule fois. Sans réponse, rien ne bouge : elle
 * reste sur le tableau de son dernier jour.
 */
export async function askEndedSpans(client: Client): Promise<void> {
  if (askingSpans) return;
  askingSpans = true;
  try {
    const now = Date.now();
    for (const span of await listOpenSpans()) {
      const end = spanEnd(span);
      if (end === null || end > now || span.asked_at) continue;
      try {
        await askSpan(client, span);
      } catch (err) {
        logger.error({ err, span: span.id }, 'question de fin de periode non posee');
      }
    }
  } finally {
    askingSpans = false;
  }
}

async function askSpan(client: Client, span: EssortSpanRow): Promise<void> {
  const channel = await fetchChannel(client, span.channel_id);
  if (!channel) return;
  // Marquée d'abord : à la minute suivante, la question ne repart pas en double.
  await updateSpan(span.id, { asked_at: new Date().toISOString() });
  // Pour toute l'équipe : chacun est tagué, la question reste dans le salon d'origine.
  const userIds = spanPeople(span)
    .map((p) => memberOf(p)?.userId)
    .filter((id): id is string => Boolean(id));
  const mention = userIds.length > 0 ? userIds.map((id) => userMention(id)).join(' ') : null;
  try {
    const sent = await channel.send({
      ...buildSpanQuestion(span, mention),
      allowedMentions: { users: userIds },
    });
    await updateSpan(span.id, { ask_message_id: sent.id });
    logger.info({ person: span.person, span: span.id }, 'question de fin de periode posee');
  } catch (err) {
    // Rien n'est parti : nouvel essai à la minute suivante.
    await updateSpan(span.id, { asked_at: null });
    throw err;
  }
}

/**
 * Réponse à la question de fin de période : « Faite » ou « Abandonner ».
 * @param messageId le message de la question (si sa référence n'a pas pu être enregistrée)
 */
export async function answerSpan(
  client: Client,
  spanId: number,
  answer: 'done' | 'drop',
  by: string,
  messageId: string,
): Promise<void> {
  const found = await getSpan(spanId);
  if (!found) return;
  const span = { ...found, ask_message_id: found.ask_message_id ?? messageId };
  if (!isSpanOpen(span)) {
    // Déjà cochée ou retirée depuis le tableau : la question le dit.
    const outcome = span.done_at ? 'done' : 'drop';
    await closeSpanQuestion(client, span, spanClosedText(span, outcome, span.done_by));
    return;
  }

  if (answer === 'drop') {
    await dropSpan(client, span, by);
  } else {
    const doneAt = new Date().toISOString();
    await updateSpan(span.id, { done_at: doneAt, done_by: by });
    // Sa dernière ligne est cochée (celle de qui répond, pour une tâche de toute
    // l'équipe) : le tableau et le Sheet le montrent. Les autres lignes partent.
    const rows = await listSpanRows(span.id);
    const latest = rows.filter(
      (r) => r.essort_boards.board_date === rows[0]?.essort_boards.board_date,
    );
    const row = latest.find((r) => r.essort_boards.person === by) ?? latest[0];
    if (row && !row.is_done) {
      await updateTask(row.id, { is_done: true, done_at: doneAt, done_by: by });
      if (row.essort_boards.board_date !== essortToday()) {
        await withBoardLock(row.board_id, () => renderBoard(client, row.board_id, { week: false }));
      }
      void syncDoneTasks();
    }
    await closeSpanQuestion(client, span, spanClosedText(span, 'done', by));
  }
  await refreshSpanBoards(client, span);
  logger.info({ person: span.person, span: span.id, answer, by }, 'fin de periode : reponse');
}

/** « Reporter » : la période court jusqu'à sa nouvelle fin ; une nouvelle question suivra. */
export async function reportSpan(
  client: Client,
  spanId: number,
  end: Moment,
  by: string,
  messageId: string,
): Promise<EssortSpanRow | null> {
  const found = await getSpan(spanId);
  if (!found || found.kind !== 'period' || !isSpanOpen(found)) return null;
  const updated = await updateSpan(found.id, {
    end_date: end.date,
    end_time: end.time ?? DEFAULT_END_TIME,
    asked_at: null,
    ask_message_id: null,
  });
  if (!updated) return null;
  await closeSpanQuestion(
    client,
    { ...found, ask_message_id: found.ask_message_id ?? messageId },
    spanClosedText(updated, 'report', by),
  );
  await refreshSpanBoards(client, updated);
  logger.info(
    { person: found.person, span: found.id, end: `${updated.end_date} ${updated.end_time}`, by },
    'periode reportee',
  );
  return updated;
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
  'Fiche CRM',
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
    task.source === 'airtable' ? 'CRM' : 'Ajoutée',
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
