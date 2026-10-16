import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EssortBoardRow, EssortSpanRow, EssortTaskRow } from '../db/essortRepository';

// Base en mémoire à la place de Supabase.
const db = vi.hoisted(() => ({
  boards: [] as EssortBoardRow[],
  tasks: [] as EssortTaskRow[],
  spans: [] as EssortSpanRow[],
  nextId: 1,
}));

vi.mock('../db/essortRepository', () => {
  const withBoard = (t: EssortTaskRow) => {
    const b = db.boards.find((x) => x.id === t.board_id)!;
    return { ...t, essort_boards: { person: b.person, board_date: b.board_date } };
  };
  const getBoard = async (person: string, date: string) =>
    db.boards.find((b) => b.person === person && b.board_date === date) ?? null;
  return {
    getBoard,
    getBoardById: async (id: number) => db.boards.find((b) => b.id === id) ?? null,
    ensureBoard: async (person: EssortBoardRow['person'], date: string, channelId: string) => {
      const existing = await getBoard(person, date);
      if (existing) return { board: existing, created: false };
      const board = {
        id: db.nextId++,
        person,
        board_date: date,
        channel_id: channelId,
        message_id: null,
        week_message_id: null,
        evening_message_id: null,
        evening_answered_at: null,
        extras: {},
        read_at: null,
        archived_at: null,
        created_at: '',
      } as EssortBoardRow;
      db.boards.push(board);
      return { board, created: true };
    },
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
    moveTask: async (id: number, boardId: number, position: number, carriedFrom: number | null) => {
      const row = db.tasks.find((t) => t.id === id)!;
      Object.assign(row, { board_id: boardId, position, carried_from: carriedFrom, pings_sent: 0 });
    },
    listCarriedFrom: async (boardId: number) =>
      db.tasks.filter((t) => t.carried_from === boardId && !t.dismissed_at),
    listAirtableTasksFor: async () => [],
    listTasksToSync: async () => [],
    listBoardsToArchive: async () => [],
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
    addSpan: async (span: Partial<EssortSpanRow>) => {
      const row = {
        id: db.nextId++,
        start_time: null,
        end_date: null,
        end_time: null,
        done_at: null,
        done_by: null,
        dismissed_at: null,
        asked_at: null,
        ask_message_id: null,
        created_at: '',
        ...span,
      } as EssortSpanRow;
      db.spans.push(row);
      return row;
    },
    getSpan: async (id: number) => db.spans.find((s) => s.id === id) ?? null,
    updateSpan: async (id: number, patch: Partial<EssortSpanRow>) => {
      const row = db.spans.find((s) => s.id === id);
      if (row) Object.assign(row, patch);
      return row ? { ...row } : null;
    },
    listOpenSpans: async (person?: string) =>
      db.spans.filter(
        (s) => !s.done_at && !s.dismissed_at && (person === undefined || s.person === person),
      ),
    listSpanRows: async (spanId: number) =>
      db.tasks
        .filter((t) => t.span_id === spanId && !t.dismissed_at)
        .map(withBoard)
        .sort((a, b) => b.essort_boards.board_date.localeCompare(a.essort_boards.board_date)),
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
vi.mock('./airtable', () => ({ fetchLeads: async () => [], recordUrl: (id: string) => id }));

const service = await import('./service');
const {
  answerSpan,
  askEndedSpans,
  carryAll,
  createSpan,
  editSpan,
  futureSpans,
  placeSpans,
  removeTasks,
  reportSpan,
  toggleTasks,
} = service;

// Un faux Discord : ce qui est envoyé, et ce qui est modifié.
const sent: { id: string; content?: string; embeds?: { toJSON(): { description?: string } }[] }[] =
  [];
const edits = new Map<string, { content?: string }>();
const channel = {
  isTextBased: () => true,
  isSendable: () => true,
  send: async (payload: object) => {
    const message = { id: `m${sent.length + 1}`, ...payload };
    sent.push(message);
    return message;
  },
  messages: {
    fetch: async (id: string) => ({
      edit: async (payload: { content?: string }) => {
        edits.set(id, payload);
      },
    }),
    delete: async () => undefined,
  },
};
const client = { channels: { fetch: async () => channel } } as unknown as Client;

/** Instant de Paris (heure d'été, UTC+2). */
const paris = (date: string, time: string) => new Date(`${date}T${time}:00+02:00`);

async function board(date: string, published = false): Promise<EssortBoardRow> {
  const { ensureBoard } = await import('../db/essortRepository');
  const { board: b } = await ensureBoard('Loys', date, 'salon-loys');
  if (published) b.message_id = `jour-${date}`;
  return b;
}
const rowsOf = (b: EssortBoardRow) =>
  db.tasks.filter((t) => t.board_id === b.id && !t.dismissed_at);

beforeEach(() => {
  db.boards = [];
  db.tasks = [];
  db.spans = [];
  sent.length = 0;
  edits.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('tâche permanente', () => {
  it('revient chaque jour tant qu’elle n’est pas cochée, puis plus jamais', async () => {
    vi.setSystemTime(paris('2026-10-19', '08:00'));
    const monday = await board('2026-10-19');
    await createSpan(client, monday, {
      kind: 'permanent',
      label: 'Relancer les devis',
      start: { date: '2026-10-19', time: null },
      end: null,
    });
    expect(rowsOf(monday)).toMatchObject([
      { label: 'Relancer les devis', details: 'Tous les jours, jusqu’à ce qu’elle soit faite' },
    ]);

    vi.setSystemTime(paris('2026-10-20', '06:00'));
    const tuesday = await board('2026-10-20');
    await placeSpans(tuesday);
    await placeSpans(tuesday); // à chaque relecture : pas de doublon
    const [row] = rowsOf(tuesday);
    expect(rowsOf(tuesday)).toHaveLength(1);

    await toggleTasks(client, tuesday, [row!.id], 'Loys');
    expect(db.spans[0]!.done_by).toBe('Loys');
    // Lundi garde sa ligne non cochée : ce jour-là, elle n'avait pas été faite.
    expect(rowsOf(monday)[0]!.is_done).toBe(false);

    vi.setSystemTime(paris('2026-10-21', '06:00'));
    const wednesday = await board('2026-10-21');
    await placeSpans(wednesday);
    expect(rowsOf(wednesday)).toEqual([]);
  });

  it('décochée le jour même, elle reviendra le lendemain', async () => {
    vi.setSystemTime(paris('2026-10-19', '08:00'));
    const monday = await board('2026-10-19');
    await createSpan(client, monday, {
      kind: 'permanent',
      label: 'Relancer les devis',
      start: { date: '2026-10-19', time: null },
      end: null,
    });
    const [row] = rowsOf(monday);
    await toggleTasks(client, monday, [row!.id], 'Loys');
    await toggleTasks(client, monday, [row!.id], 'Loys');
    expect(db.spans[0]!.done_at).toBeNull();
    const tuesday = await board('2026-10-20');
    await placeSpans(tuesday);
    expect(rowsOf(tuesday)).toHaveLength(1);
  });

  it('retirée du jour, elle ne revient pas', async () => {
    vi.setSystemTime(paris('2026-10-19', '08:00'));
    const monday = await board('2026-10-19');
    await createSpan(client, monday, {
      kind: 'permanent',
      label: 'Relancer les devis',
      start: { date: '2026-10-19', time: null },
      end: null,
    });
    await removeTasks(client, monday, [rowsOf(monday)[0]!.id]);
    expect(db.spans[0]!.dismissed_at).not.toBeNull();
    const tuesday = await board('2026-10-20');
    await placeSpans(tuesday);
    expect(rowsOf(tuesday)).toEqual([]);
  });

  it('le soir, elle n’est pas proposée au report : elle revient seule', async () => {
    vi.setSystemTime(paris('2026-10-19', '19:00'));
    const monday = await board('2026-10-19');
    const { addTask } = await import('../db/essortRepository');
    await addTask({ board_id: monday.id, source: 'manual', label: 'Envoyer le devis' });
    await createSpan(client, monday, {
      kind: 'permanent',
      label: 'Relancer les devis',
      start: { date: '2026-10-19', time: null },
      end: null,
    });
    await carryAll(client, monday, 'Loys');
    const tuesday = await board('2026-10-20');
    expect(rowsOf(tuesday).map((t) => t.label)).toEqual(['Envoyer le devis']);
    expect(rowsOf(monday).map((t) => t.label)).toEqual(['Relancer les devis']);
  });
});

describe('tâche sur une période', () => {
  it('s’affiche sur son créneau, puis le bot demande si elle a pu être faite', async () => {
    vi.setSystemTime(paris('2026-10-19', '08:00'));
    const monday = await board('2026-10-19');
    const span = await createSpan(client, monday, {
      kind: 'period',
      label: 'Préparer la présentation',
      start: { date: '2026-10-20', time: '09:00' },
      end: { date: '2026-10-21', time: '18:00' },
    });
    // Pas encore commencée : rien aujourd'hui, elle est dans la semaine.
    expect(rowsOf(monday)).toEqual([]);
    expect(await futureSpans(monday)).toHaveLength(1);
    expect(
      sent.some((m) =>
        m.embeds?.[0]
          ?.toJSON()
          .description?.includes('Préparer la présentation (jusqu’au mer. 21/10 18:00)'),
      ),
    ).toBe(true);

    vi.setSystemTime(paris('2026-10-20', '06:00'));
    const tuesday = await board('2026-10-20');
    await placeSpans(tuesday);
    expect(rowsOf(tuesday)).toMatchObject([
      { due_time: '09:00', details: 'Jusqu’au mercredi 21/10, 18:00', span_id: span.id },
    ]);

    vi.setSystemTime(paris('2026-10-21', '06:00'));
    const wednesday = await board('2026-10-21', true);
    await placeSpans(wednesday);
    expect(rowsOf(wednesday)).toMatchObject([{ due_time: null, details: 'Jusqu’à 18:00' }]);

    // Avant la fin : pas de question.
    vi.setSystemTime(paris('2026-10-21', '17:59'));
    sent.length = 0;
    await askEndedSpans(client);
    expect(sent).toEqual([]);

    // À la fin : une seule question, même si la vérification repasse.
    vi.setSystemTime(paris('2026-10-21', '18:00'));
    await askEndedSpans(client);
    await askEndedSpans(client);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toContain('Fin de la période : **Préparer la présentation**');
    const question = db.spans[0]!.ask_message_id!;
    expect(question).toBe(sent[0]!.id);

    // « Reporter » à jeudi midi : la question se clôt, une nouvelle suivra.
    await reportSpan(client, span.id, { date: '2026-10-22', time: '12:00' }, 'Loys', question);
    expect(edits.get(question)?.content).toBe(
      'Reportée au jeu. 22/10 12:00 : **Préparer la présentation** (Loys)',
    );
    expect(rowsOf(wednesday)[0]!.details).toBe('Jusqu’au jeudi 22/10, 12:00');

    vi.setSystemTime(paris('2026-10-22', '06:00'));
    const thursday = await board('2026-10-22', true);
    await placeSpans(thursday);
    expect(rowsOf(thursday)).toHaveLength(1);

    vi.setSystemTime(paris('2026-10-22', '12:00'));
    sent.length = 0;
    await askEndedSpans(client);
    expect(sent).toHaveLength(1);
    const second = sent[0]!.id;

    // « Faite » : sa dernière ligne est cochée, la question close.
    await answerSpan(client, span.id, 'done', 'Enzo', second);
    expect(db.spans[0]!.done_by).toBe('Enzo');
    expect(rowsOf(thursday)[0]!.is_done).toBe(true);
    expect(edits.get(second)?.content).toBe('✅ Faite : **Préparer la présentation** (Enzo)');

    const friday = await board('2026-10-23');
    await placeSpans(friday);
    expect(rowsOf(friday)).toEqual([]);
  });

  it('sans réponse, rien ne bouge : elle reste sur son dernier jour, sans revenir', async () => {
    vi.setSystemTime(paris('2026-10-19', '08:00'));
    const monday = await board('2026-10-19');
    await createSpan(client, monday, {
      kind: 'period',
      label: 'Finir le dossier',
      start: { date: '2026-10-19', time: null },
      end: { date: '2026-10-19', time: '17:00' },
    });
    vi.setSystemTime(paris('2026-10-19', '17:01'));
    await askEndedSpans(client);
    await placeSpans(monday);
    expect(rowsOf(monday)).toHaveLength(1);
    const tuesday = await board('2026-10-20');
    await placeSpans(tuesday);
    expect(rowsOf(tuesday)).toEqual([]);
    expect(db.spans[0]!.done_at).toBeNull();
    expect(db.spans[0]!.dismissed_at).toBeNull();
  });

  it('modifiée, sa ligne du jour suit ; « Abandonner » la retire', async () => {
    vi.setSystemTime(paris('2026-10-19', '08:00'));
    const monday = await board('2026-10-19', true);
    const span = await createSpan(client, monday, {
      kind: 'period',
      label: 'Finir le dossier',
      start: { date: '2026-10-19', time: '14:00' },
      end: { date: '2026-10-20', time: '18:00' },
    });
    expect(rowsOf(monday)).toMatchObject([{ due_time: '14:00' }]);

    await editSpan(client, monday, span.id, {
      label: 'Finir le dossier Martin',
      start: { date: '2026-10-19', time: '15:00' },
      end: { date: '2026-10-21', time: null },
    });
    expect(rowsOf(monday)).toMatchObject([
      {
        label: 'Finir le dossier Martin',
        due_time: '15:00',
        details: 'Jusqu’au mercredi 21/10, 19:00',
      },
    ]);

    await answerSpan(client, span.id, 'drop', 'Loys', '');
    expect(db.spans[0]!.dismissed_at).not.toBeNull();
    expect(rowsOf(monday)).toEqual([]);
  });
});
