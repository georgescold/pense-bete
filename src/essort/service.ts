import { Client, userMention, type SendableChannels } from 'discord.js';
import { config, essortMembers, type EssortMember, type EssortPerson } from '../config';
import { logger } from '../logger';
import {
  addTask,
  ensureBoard,
  getBoard,
  getBoardById,
  getTask,
  listBoardsToArchive,
  listHandledAirtableTasks,
  listOpenTasksBefore,
  listTasks,
  listTasksToSync,
  moveTask,
  updateBoard,
  updateTask,
  deleteTask,
  type BoardExtras,
  type EssortBoardRow,
  type EssortTaskRow,
  type TaskWithBoard,
} from '../db/essortRepository';
import { formatPlanDate } from '../daily/ui';
import { parisDateValue } from '../lib/datetime';
import { appendRowsTo, clearRange, isSheetsConfigured } from '../lib/sheets';
import { fetchLeads, recordUrl } from './airtable';
import { buildAgenda, padDate, type Agenda } from './planner';
import { boardIntro, buildBoardComponents, buildBoardEmbed } from './ui';

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

/** Au lever : 3 essais sur ~40 s. Sur un clic : un seul, la personne attend. */
const MORNING_READ_DELAYS = [0, 10_000, 30_000];

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
// Construction d'un tableau
// ---------------------------------------------------------------------------

function nextPosition(tasks: EssortTaskRow[]): number {
  return tasks.length > 0 ? Math.max(...tasks.map((t) => t.position)) + 1 : 0;
}

/**
 * Aligne les tâches Airtable du tableau sur l'agenda lu :
 *  - une action échue apparaît (une seule fois par lead et par action) ;
 *  - une action déjà validée un autre jour, dont la date n'a pas bougé dans
 *    Airtable, ne revient pas : elle est signalée « date à changer » ;
 *  - une action retirée depuis Discord ne revient pas non plus ;
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
  const history = await listHandledAirtableTasks(plan.due.map((d) => d.recordId));
  const keep = new Set<number>();
  const stale: NonNullable<BoardExtras['stale']> = [];
  let position = nextPosition(tasks);

  for (const due of plan.due) {
    const onBoard = tasks.filter((t) => t.source === 'airtable' && t.record_id === due.recordId);

    const same = onBoard.find((t) => t.signature === due.signature);
    if (same) {
      keep.add(same.id);
      const open = !same.is_done && !same.dismissed_at;
      if (open && (same.label !== due.label || same.details !== due.details)) {
        await updateTask(same.id, { label: due.label, details: due.details });
      }
      continue;
    }

    const handled = history.filter((t) => t.signature === due.signature && t.board_id !== board.id);
    if (handled.length > 0) {
      // Faite : on rappelle de changer la date dans Airtable. Retirée : on
      // respecte le choix, sans rien afficher.
      const done = handled.find((t) => t.is_done && t.done_at);
      if (done)
        stale.push({ label: due.label, doneOn: essortToday(new Date(done.done_at as string)) });
      continue;
    }

    // Même lead, autre action ou autre date : on met la tâche à jour sur place
    // plutôt que d'en empiler une seconde.
    const pending = onBoard.find((t) => !t.is_done && !t.dismissed_at);
    if (pending) {
      keep.add(pending.id);
      await updateTask(pending.id, {
        signature: due.signature,
        label: due.label,
        details: due.details,
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
      position: position++,
    });
    keep.add(added.id);
  }

  for (const t of tasks) {
    const open = !t.is_done && !t.dismissed_at;
    if (t.source === 'airtable' && open && !keep.has(t.id)) await deleteTask(t.id);
  }

  await updateBoard(board.id, {
    extras: {
      upcoming: plan.upcoming,
      undated: plan.undated,
      unassigned: agenda.unassigned,
      stale,
      airtableError: false,
    },
    read_at: new Date().toISOString(),
  });
}

/**
 * Une tâche non faite ne disparaît pas avec la journée : la même ligne passe
 * sur le tableau du jour et y reste jusqu'à être faite ou retirée. Les
 * tableaux passés ne gardent ainsi que ce qui y a été fait.
 */
export async function moveOpenTasks(board: EssortBoardRow): Promise<void> {
  const open = await listOpenTasksBefore(board.person, board.board_date);
  if (open.length === 0) return;
  let position = nextPosition(await listTasks(board.id, true));
  for (const t of open) await moveTask(t.id, board.id, position++);
  logger.info({ board: board.id, moved: open.length }, 'taches ouvertes reportees sur le jour');
}

/** Code d'erreur Discord d'un message qui n'existe plus. */
const UNKNOWN_MESSAGE = 10008;

/** Publie le tableau s'il n'a pas encore de message, sinon le met à jour. */
export async function renderBoard(client: Client, boardId: number): Promise<void> {
  const board = await getBoardById(boardId);
  if (!board) return;
  const channel = await fetchChannel(client, board.channel_id);
  if (!channel) return;

  const tasks = await listTasks(board.id);
  const remaining = tasks.filter((t) => !t.is_done).length;
  const userId = memberOf(board.person)?.userId ?? null;
  const payload = {
    content: board.archived_at
      ? ''
      : boardIntro(userId ? userMention(userId) : null, remaining, tasks.length),
    embeds: [buildBoardEmbed(board, tasks)],
    components: buildBoardComponents(board, tasks),
  };

  if (board.message_id) {
    try {
      const msg = await channel.messages.fetch(board.message_id);
      await msg.edit({ ...payload, allowedMentions: { parse: [] } });
      return;
    } catch (err) {
      logger.warn({ err, id: board.id }, 'message Essort non modifiable');
      // Seul un message supprimé à la main (10008) justifie de republier, et
      // seulement celui du jour : une simple erreur réseau ne doit pas doubler
      // le tableau.
      if (board.archived_at || (err as { code?: unknown }).code !== UNKNOWN_MESSAGE) return;
    }
  }

  const sent = await channel.send({
    ...payload,
    allowedMentions: { users: userId && remaining > 0 ? [userId] : [] },
  });
  await updateBoard(board.id, { message_id: sent.id });
}

/** Retire les boutons des tableaux des jours passés. */
async function archivePastBoards(
  client: Client,
  person: EssortPerson,
  date: string,
): Promise<void> {
  for (const old of await listBoardsToArchive(person, date)) {
    await updateBoard(old.id, { archived_at: new Date().toISOString() });
    if (old.message_id) await renderBoard(client, old.id);
  }
}

async function publishBoard(
  client: Client,
  member: EssortMember,
  date: string,
  agenda: Agenda | null,
): Promise<void> {
  const { board } = await ensureBoard(member.person, date, member.channelId);
  await withBoardLock(board.id, async () => {
    // Ce qui reste à faire d'abord, puis les tableaux passés sont figés (sans
    // boutons, avec ce qui y a été fait), enfin Airtable ajoute les nouveautés.
    await moveOpenTasks(board);
    await archivePastBoards(client, member.person, date);
    await reconcile(board, agenda);
    await renderBoard(client, board.id);
  });
  logger.info({ person: member.person, date, board: board.id }, 'tableau Essort publie');
}

/**
 * Rendez-vous de 6h (et relectures de la journée) : un tableau par personne
 * configurée. Publier un tableau déjà posté le met simplement à jour, sans
 * nouvelle mention.
 *
 * @param onlyMissing ne traiter que les personnes dont le tableau du jour n'a
 * pas encore de message (rattrapage au démarrage, sans relire Airtable pour
 * rien à chaque redémarrage).
 */
export async function publishBoards(client: Client, onlyMissing = false): Promise<void> {
  const date = essortToday();
  const members: EssortMember[] = [];
  for (const m of essortMembers) {
    const existing = onlyMissing ? await getBoard(m.person, date) : null;
    if (!existing?.message_id) members.push(m);
  }
  if (members.length === 0) return;

  const agenda = await readAgenda(date, MORNING_READ_DELAYS);
  const failures: unknown[] = [];
  for (const m of members) {
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

// ---------------------------------------------------------------------------
// Actions depuis Discord
// ---------------------------------------------------------------------------

export function refreshBoard(client: Client, board: EssortBoardRow): Promise<void> {
  return withBoardLock(board.id, async () => {
    const fresh = (await getBoardById(board.id)) ?? board;
    await reconcile(fresh, await readAgenda(fresh.board_date, [0]));
    await renderBoard(client, board.id);
  });
}

export function addManualTask(client: Client, board: EssortBoardRow, label: string): Promise<void> {
  return withBoardLock(board.id, async () => {
    const tasks = await listTasks(board.id);
    await addTask({ board_id: board.id, source: 'manual', label, position: nextPosition(tasks) });
    await renderBoard(client, board.id);
  });
}

/**
 * Retire des tâches du tableau et renvoie leurs libellés.
 *
 * Une tâche ajoutée à la main est supprimée. Une tâche Airtable est seulement
 * masquée : elle ne revient pas aux relectures suivantes tant que l'action ou
 * la date du lead ne changent pas. Si la tâche était déjà dans le Sheet, sa
 * ligne est effacée.
 */
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
      // Décochée avant tout : plus aucune synchro ne la recopiera dans le Sheet.
      await updateTask(task.id, {
        is_done: false,
        done_at: null,
        done_by: null,
        dismissed_at: new Date().toISOString(),
      });
      await removeFromSheet(task.id);
      if (task.source === 'manual') await deleteTask(task.id);
      removed.push(task.label);
    }
    if (removed.length > 0) await renderBoard(client, board.id);
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
    await renderBoard(client, board.id);
    void syncDoneTasks();
  });
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
    task.label,
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
