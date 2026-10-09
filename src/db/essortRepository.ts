import type { EssortPerson } from '../config';
import type { CrmMatch } from '../essort/planner';
import { supabase } from './supabase';

export interface BoardExtras {
  /** Actions Airtable des 6 jours suivants (planning de la semaine). */
  upcoming?: { date: string; time: string | null; label: string; match?: CrmMatch }[];
  /** Dernière lecture d'Airtable en échec : la liste est incomplète. */
  airtableError?: boolean;
}

export interface EssortBoardRow {
  id: number;
  person: EssortPerson;
  board_date: string; // 'YYYY-MM-DD', date murale Europe/Paris
  channel_id: string;
  /** Message du jour (tâches à cocher). */
  message_id: string | null;
  /** Message de la semaine, posté juste avant celui du jour. */
  week_message_id: string | null;
  /** Question de 19h « Reporter à demain ? », et le moment où on y a répondu. */
  evening_message_id: string | null;
  evening_answered_at: string | null;
  extras: BoardExtras;
  read_at: string | null;
  archived_at: string | null;
  created_at: string;
}

export type TaskSource = 'airtable' | 'manual';

export interface EssortTaskRow {
  id: number;
  board_id: number;
  source: TaskSource;
  record_id: string | null;
  signature: string | null;
  label: string;
  details: string | null;
  /** 'HH:MM', heure de Paris : ping à l'heure dite. */
  due_time: string | null;
  /** Pings déjà envoyés avant l'heure (1 h, 30 min, 10 min) : 0 à 3. */
  pings_sent: number;
  position: number;
  is_done: boolean;
  done_at: string | null;
  done_by: string | null;
  /** Retirée depuis Discord : invisible, mais gardée pour ne pas revenir. */
  dismissed_at: string | null;
  /** Tableau d'où la tâche a été reportée le soir (pour annuler le report). */
  carried_from: number | null;
  /** Modifiée depuis Discord : une relecture du CRM ne la réécrit pas. */
  edited_at: string | null;
  sheet_range: string | null;
  created_at: string;
}

export type BoardPatch = Partial<
  Pick<
    EssortBoardRow,
    | 'message_id'
    | 'week_message_id'
    | 'evening_message_id'
    | 'evening_answered_at'
    | 'extras'
    | 'read_at'
    | 'archived_at'
  >
>;
export type TaskPatch = Partial<
  Pick<
    EssortTaskRow,
    | 'label'
    | 'details'
    | 'due_time'
    | 'pings_sent'
    | 'edited_at'
    | 'signature'
    | 'position'
    | 'is_done'
    | 'done_at'
    | 'done_by'
    | 'dismissed_at'
    | 'sheet_range'
  >
>;

const BOARDS = 'essort_boards';
const TASKS = 'essort_tasks';

export async function getBoard(person: EssortPerson, date: string): Promise<EssortBoardRow | null> {
  const { data, error } = await supabase
    .from(BOARDS)
    .select()
    .eq('person', person)
    .eq('board_date', date)
    .maybeSingle();
  if (error) throw new Error(`getBoard: ${error.message}`);
  return (data as EssortBoardRow) ?? null;
}

export async function getBoardById(id: number): Promise<EssortBoardRow | null> {
  const { data, error } = await supabase.from(BOARDS).select().eq('id', id).maybeSingle();
  if (error) throw new Error(`getBoardById: ${error.message}`);
  return (data as EssortBoardRow) ?? null;
}

/** Tableaux de jours passés dont le message a encore ses boutons. */
export async function listBoardsToArchive(
  person: EssortPerson,
  before: string,
): Promise<EssortBoardRow[]> {
  const { data, error } = await supabase
    .from(BOARDS)
    .select()
    .eq('person', person)
    .lt('board_date', before)
    .is('archived_at', null);
  if (error) throw new Error(`listBoardsToArchive: ${error.message}`);
  return (data ?? []) as EssortBoardRow[];
}

/**
 * Crée le tableau du jour s'il n'existe pas. `created` indique si on vient de
 * le créer : c'est le seul moment où l'on reprend les tâches de la veille.
 */
export async function ensureBoard(
  person: EssortPerson,
  date: string,
  channelId: string,
): Promise<{ board: EssortBoardRow; created: boolean }> {
  const existing = await getBoard(person, date);
  if (existing) return { board: existing, created: false };
  const { data, error } = await supabase
    .from(BOARDS)
    .insert({ person, board_date: date, channel_id: channelId })
    .select()
    .single();
  if (error) {
    // Course entre le job de 6h et le rattrapage au démarrage : on relit.
    const retry = await getBoard(person, date);
    if (retry) return { board: retry, created: false };
    throw new Error(`ensureBoard: ${error.message}`);
  }
  return { board: data as EssortBoardRow, created: true };
}

export async function updateBoard(id: number, patch: BoardPatch): Promise<EssortBoardRow | null> {
  const { data, error } = await supabase
    .from(BOARDS)
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(`updateBoard: ${error.message}`);
  return (data as EssortBoardRow) ?? null;
}

/**
 * Tâches d'un tableau, dans l'ordre d'affichage. Les tâches retirées n'en font
 * partie que sur demande (pour savoir qu'une action a déjà été écartée).
 */
export async function listTasks(
  boardId: number,
  includeDismissed = false,
): Promise<EssortTaskRow[]> {
  let query = supabase.from(TASKS).select().eq('board_id', boardId);
  if (!includeDismissed) query = query.is('dismissed_at', null);
  const { data, error } = await query
    .order('position', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`listTasks: ${error.message}`);
  return (data ?? []) as EssortTaskRow[];
}

export async function getTask(id: number): Promise<EssortTaskRow | null> {
  const { data, error } = await supabase.from(TASKS).select().eq('id', id).maybeSingle();
  if (error) throw new Error(`getTask: ${error.message}`);
  return (data as EssortTaskRow) ?? null;
}

export async function listTasksByIds(ids: number[]): Promise<EssortTaskRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from(TASKS).select().in('id', ids);
  if (error) throw new Error(`listTasksByIds: ${error.message}`);
  return (data ?? []) as EssortTaskRow[];
}

export async function addTask(
  task: Pick<EssortTaskRow, 'board_id' | 'source' | 'label'> &
    Partial<Pick<EssortTaskRow, 'record_id' | 'signature' | 'details' | 'due_time' | 'position'>>,
): Promise<EssortTaskRow> {
  const { data, error } = await supabase.from(TASKS).insert(task).select().single();
  if (error) throw new Error(`addTask: ${error.message}`);
  return data as EssortTaskRow;
}

export async function updateTask(id: number, patch: TaskPatch): Promise<EssortTaskRow | null> {
  const { data, error } = await supabase
    .from(TASKS)
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(`updateTask: ${error.message}`);
  return (data as EssortTaskRow) ?? null;
}

export async function deleteTask(id: number): Promise<void> {
  const { error } = await supabase.from(TASKS).delete().eq('id', id);
  if (error) throw new Error(`deleteTask: ${error.message}`);
}

/**
 * Toutes les tâches Airtable déjà créées pour ces leads, tous jours et tous
 * états confondus : faites, retirées, ou laissées sans report sur leur jour.
 */
export async function listAirtableTasksFor(recordIds: string[]): Promise<EssortTaskRow[]> {
  if (recordIds.length === 0) return [];
  const { data, error } = await supabase
    .from(TASKS)
    .select()
    .eq('source', 'airtable')
    .in('record_id', recordIds);
  if (error) throw new Error(`listAirtableTasksFor: ${error.message}`);
  return (data ?? []) as EssortTaskRow[];
}

export type TaskWithBoard = EssortTaskRow & {
  essort_boards: Pick<EssortBoardRow, 'person' | 'board_date'>;
};

/**
 * Rattache une tâche à un autre tableau (même ligne, nouvelle place).
 * @param carriedFrom tableau d'origine d'un report du soir, null pour l'effacer.
 */
export async function moveTask(
  id: number,
  boardId: number,
  position: number,
  carriedFrom: number | null,
): Promise<void> {
  const { error } = await supabase
    .from(TASKS)
    .update({ board_id: boardId, position, carried_from: carriedFrom, pings_sent: 0 })
    .eq('id', id);
  if (error) throw new Error(`moveTask: ${error.message}`);
}

/** Tâches reportées le soir depuis ce tableau (où qu'elles soient maintenant). */
export async function listCarriedFrom(boardId: number): Promise<EssortTaskRow[]> {
  const { data, error } = await supabase
    .from(TASKS)
    .select()
    .eq('carried_from', boardId)
    .is('dismissed_at', null)
    .order('id', { ascending: true });
  if (error) throw new Error(`listCarriedFrom: ${error.message}`);
  return (data ?? []) as EssortTaskRow[];
}

/** Tâches faites pas encore recopiées dans le Google Sheet. */
export async function listTasksToSync(): Promise<TaskWithBoard[]> {
  const { data, error } = await supabase
    .from(TASKS)
    .select('*, essort_boards!inner(person, board_date)')
    .eq('is_done', true)
    .is('dismissed_at', null)
    .is('sheet_range', null)
    .order('done_at', { ascending: true });
  if (error) throw new Error(`listTasksToSync: ${error.message}`);
  return (data ?? []) as TaskWithBoard[];
}

/**
 * Tâches posées sur des jours à venir (bornes incluses) : planifiées à la
 * main, ou reportées depuis le soir.
 */
export async function listPlannedTasks(
  person: EssortPerson,
  from: string,
  to: string,
): Promise<TaskWithBoard[]> {
  const { data, error } = await supabase
    .from(TASKS)
    .select('*, essort_boards!inner(person, board_date)')
    .is('dismissed_at', null)
    .eq('essort_boards.person', person)
    .gte('essort_boards.board_date', from)
    .lte('essort_boards.board_date', to);
  if (error) throw new Error(`listPlannedTasks: ${error.message}`);
  return ((data ?? []) as TaskWithBoard[]).sort(
    (a, b) =>
      a.essort_boards.board_date.localeCompare(b.essort_boards.board_date) ||
      (a.due_time ?? '99').localeCompare(b.due_time ?? '99') ||
      a.id - b.id,
  );
}
