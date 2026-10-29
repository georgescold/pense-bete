import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EssortBoardRow, EssortTaskRow } from '../db/essortRepository';
import type { CrmData } from './crm';

// Deux tableaux configurés, quel que soit le .env de la machine.
vi.hoisted(() => {
  process.env.ESSORT_LOYS_CHANNEL_ID = 'salon-loys';
  process.env.ESSORT_LOYS_USER_ID = 'u-loys';
  process.env.ESSORT_ENZO_CHANNEL_ID = 'salon-enzo';
  process.env.ESSORT_ENZO_USER_ID = 'u-enzo';
});

// Base en mémoire à la place de Supabase, et ce que renvoie la route du CRM.
const db = vi.hoisted(() => ({
  boards: [] as EssortBoardRow[],
  tasks: [] as EssortTaskRow[],
  nextId: 1,
  crm: { actions: [], taches: [] } as CrmData,
}));

vi.mock('../db/essortRepository', () => {
  const withBoard = (t: EssortTaskRow) => {
    const b = db.boards.find((x) => x.id === t.board_id)!;
    return { ...t, essort_boards: { person: b.person, board_date: b.board_date } };
  };
  return {
    getBoard: async (person: string, date: string) =>
      db.boards.find((b) => b.person === person && b.board_date === date) ?? null,
    getBoardById: async (id: number) => db.boards.find((b) => b.id === id) ?? null,
    updateBoard: async (id: number, patch: Partial<EssortBoardRow>) => {
      const board = db.boards.find((b) => b.id === id);
      if (board) Object.assign(board, patch);
      return board ?? null;
    },
    listTasks: async (boardId: number, includeDismissed = false) =>
      db.tasks
        .filter((t) => t.board_id === boardId && (includeDismissed || !t.dismissed_at))
        .sort((a, b) => a.position - b.position || a.id - b.id),
    getTask: async (id: number) => db.tasks.find((t) => t.id === id) ?? null,
    addTask: async (task: Partial<EssortTaskRow>) => {
      const row = {
        id: db.nextId++,
        record_id: null,
        signature: null,
        details: null,
        due_time: null,
        pings_sent: 0,
        position: 0,
        is_done: false,
        done_at: null,
        done_by: null,
        dismissed_at: null,
        carried_from: null,
        edited_at: null,
        span_id: null,
        sheet_range: null,
        created_at: '',
        ...task,
      } as EssortTaskRow;
      db.tasks.push(row);
      return row;
    },
    updateTask: async (id: number, patch: Partial<EssortTaskRow>) => {
      const row = db.tasks.find((t) => t.id === id);
      if (row) Object.assign(row, patch);
      return row ?? null;
    },
    deleteTask: async (id: number) => {
      db.tasks = db.tasks.filter((t) => t.id !== id);
    },
    listCarriedFrom: async () => [],
    listAirtableTasksFor: async (ids: string[]) =>
      db.tasks.filter((t) => t.source === 'airtable' && ids.includes(t.record_id ?? '')),
    listTasksToSync: async () => [],
    listOpenSpans: async () => [],
    listPlannedTasks: async (person: string, from: string, to: string) =>
      db.tasks
        .filter((t) => !t.dismissed_at)
        .map(withBoard)
        .filter(
          (t) =>
            t.essort_boards.person === person &&
            t.essort_boards.board_date >= from &&
            t.essort_boards.board_date <= to,
        ),
  };
});
vi.mock('../db/repository', () => ({ listRemindersByUser: async () => [] }));
vi.mock('../lib/sheets', () => ({
  appendRowsTo: async () => null,
  clearRange: async () => undefined,
  isSheetsConfigured: () => false,
}));
vi.mock('../lib/calendar', () => ({
  isCalendarConfigured: () => false,
  deleteEvent: async () => undefined,
  insertEvent: async () => undefined,
  listEvents: async () => [],
  updateEvent: async () => undefined,
}));
vi.mock('./crm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crm')>()),
  fetchCrm: async () => db.crm,
}));

const { syncFromCrm } = await import('./service');

// Un faux Discord : ce qui part dans chaque salon, et les messages modifiés.
const sent: { channel: string; content: string }[] = [];
const edits: { id: string; text: string }[] = [];
const channelOf = (name: string) => ({
  isTextBased: () => true,
  isSendable: () => true,
  send: async (payload: { content?: string }) => {
    sent.push({ channel: name, content: payload.content ?? '' });
    return { id: `m${sent.length}` };
  },
  messages: {
    fetch: async (id: string) => ({
      edit: async (payload: { content?: string; embeds?: { toJSON(): object }[] }) => {
        edits.push({
          id,
          text: JSON.stringify([payload.content, payload.embeds?.map((e) => e.toJSON())]),
        });
      },
    }),
    delete: async () => undefined,
  },
});
const client = {
  channels: { fetch: async (id: string) => channelOf(id) },
} as unknown as Client;

/** Instant de Paris (heure d'hiver à partir du 25/10, UTC+1). */
const paris = (date: string, time: string) => new Date(`${date}T${time}:00+01:00`);
const today = '2026-10-28';

/** Le tableau du jour, déjà publié à 6h (message de la semaine et du jour). */
function published(person: EssortBoardRow['person']): EssortBoardRow {
  const board = {
    id: db.nextId++,
    person,
    board_date: today,
    channel_id: `salon-${person.toLowerCase()}`,
    message_id: `jour-${person}`,
    week_message_id: `semaine-${person}`,
    evening_message_id: null,
    evening_answered_at: null,
    extras: {},
    read_at: null,
    archived_at: null,
    created_at: '',
  } as EssortBoardRow;
  db.boards.push(board);
  return board;
}

const rowsOf = (b: EssortBoardRow) =>
  db.tasks.filter((t) => t.board_id === b.id && !t.dismissed_at);
const pings = (channel: string) =>
  sent.filter((s) => s.channel === channel && s.content.startsWith('⏰')).map((s) => s.content);

beforeEach(() => {
  db.boards = [];
  db.tasks = [];
  db.crm = { actions: [], taches: [] };
  sent.length = 0;
  edits.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(paris(today, '13:00'));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('synchro avec le CRM', () => {
  it('une fiche avec responsable et heure arrive chez la bonne personne et sonne trois fois', async () => {
    const loys = published('Loys');
    const enzo = published('Enzo');
    db.crm.actions.push({
      id: 'f-lucie',
      nom: 'Lucie',
      cabinet: null,
      telephone: null,
      statut: 'r1',
      verdict: null,
      libelle: 'R1 · Enzo appelle Lucie',
      jour: today,
      heure: '17:00',
      responsable: 'Enzo',
    });
    // Prévue le 20/10, jamais faite : elle ne revient pas sur le tableau du jour.
    db.crm.actions.push({
      id: 'f-bastien',
      nom: 'Bastien Lambert',
      cabinet: null,
      telephone: null,
      statut: 'attente_reponse',
      verdict: null,
      libelle: 'R2 · Enzo appelle Bastien',
      jour: '2026-10-20',
      heure: '16:00',
      responsable: 'Enzo',
    });

    await syncFromCrm(client);

    expect(rowsOf(enzo)).toEqual([
      expect.objectContaining({
        source: 'airtable',
        record_id: 'lead:f-lucie',
        label: 'R1 · Enzo appelle Lucie',
        due_time: '17:00',
      }),
    ]);
    expect(rowsOf(loys)).toEqual([]);
    expect(edits.some((e) => e.id === 'jour-Enzo' && e.text.includes('Lucie'))).toBe(true);

    // 13 h → 17 h : les pings de 16 h, 16 h 30 et 16 h 50.
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(pings('salon-enzo')).toEqual([
      '⏰ <@u-enzo> **17:00** (dans 1 h) · R1 · Enzo appelle Lucie',
      '⏰ <@u-enzo> **17:00** (dans 30 min) · R1 · Enzo appelle Lucie',
      '⏰ <@u-enzo> **17:00** (dans 10 min) · R1 · Enzo appelle Lucie',
    ]);
    expect(pings('salon-loys')).toEqual([]);
  });

  it('une tâche écrite en base pour aujourd’hui apparaît et sonne sans « Actualiser »', async () => {
    const enzo = published('Enzo');
    published('Loys');
    await syncFromCrm(client);
    edits.length = 0;

    // Rien ne change dans le CRM : rien n'est réécrit.
    await syncFromCrm(client);
    expect(edits).toEqual([]);

    // Une autre session pose une tâche directement dans la base du bot.
    db.tasks.push({
      id: db.nextId++,
      board_id: enzo.id,
      source: 'manual',
      record_id: null,
      signature: null,
      label: 'Envoyer la brochure à Théo',
      details: null,
      due_time: '15:00',
      pings_sent: 0,
      position: 0,
      is_done: false,
      done_at: null,
      done_by: null,
      dismissed_at: null,
      carried_from: null,
      edited_at: null,
      span_id: null,
      sheet_range: null,
      created_at: '',
    });
    await syncFromCrm(client);
    expect(edits.some((e) => e.id === 'jour-Enzo' && e.text.includes('Envoyer la brochure'))).toBe(
      true,
    );

    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(pings('salon-enzo')).toHaveLength(3);
  });

  it('une tâche déjà écrite à la main l’emporte sur l’action du CRM qui dit la même chose', async () => {
    const enzo = published('Enzo');
    published('Loys');
    db.tasks.push({
      id: db.nextId++,
      board_id: enzo.id,
      source: 'manual',
      label: 'R1 avec Lucie',
      due_time: '17:00',
      pings_sent: 0,
      position: 0,
      is_done: false,
      dismissed_at: null,
    } as EssortTaskRow);
    db.crm.actions.push({
      id: 'f-lucie',
      nom: 'Lucie',
      cabinet: null,
      telephone: null,
      statut: 'r1',
      verdict: null,
      libelle: 'R1 · Enzo appelle Lucie',
      jour: today,
      heure: '17:00',
      responsable: 'Enzo',
    });

    await syncFromCrm(client);

    expect(rowsOf(enzo).map((t) => t.label)).toEqual(['R1 avec Lucie']);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(pings('salon-enzo')).toHaveLength(3);
  });
});
