import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EssortBoardRow, EssortSpanRow, EssortTaskRow } from '../db/essortRepository';
import type { CrmData, CrmTache } from './crm';

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
  spans: [] as EssortSpanRow[],
  nextId: 1,
  crm: { actions: [], taches: [] } as CrmData,
  /** Ce que le bot a écrit dans le CRM, et s'il répond. */
  crmLog: [] as unknown[][],
  crmDown: false,
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
    moveTask: async (id: number, boardId: number, position: number, carriedFrom: number | null) => {
      const row = db.tasks.find((t) => t.id === id)!;
      Object.assign(row, { board_id: boardId, position, carried_from: carriedFrom, pings_sent: 0 });
    },
    listBoardsToArchive: async () => [],
    addSpan: async (span: Partial<EssortSpanRow>) => {
      const row = {
        id: db.nextId++,
        shared: false,
        start_time: null,
        end_date: null,
        end_time: null,
        done_at: null,
        done_by: null,
        dismissed_at: null,
        asked_at: null,
        ask_message_id: null,
        crm_ref: null,
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
        (s) =>
          !s.done_at &&
          !s.dismissed_at &&
          (person === undefined || s.person === person || s.shared),
      ),
    listCrmSpans: async () => db.spans.filter((s) => s.crm_ref),
    listSpanRows: async (spanId: number) =>
      db.tasks.filter((t) => t.span_id === spanId && !t.dismissed_at).map(withBoard),
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
vi.mock('./crm', async (importOriginal) => {
  const original = await importOriginal<typeof import('./crm')>();
  const ecrire = (...call: unknown[]) => {
    if (db.crmDown) throw new Error(original.CRM_INJOIGNABLE);
    db.crmLog.push(call);
  };
  return {
    ...original,
    fetchCrm: async () => structuredClone(db.crm),
    crmTaches: {
      creer: async (t: unknown) => {
        ecrire('creer', t);
        return `t${db.crmLog.length}`;
      },
      modifier: async (id: string, patch: unknown) => {
        ecrire('modifier', id, patch);
        return true;
      },
      supprimer: async (id: string) => {
        ecrire('supprimer', id);
      },
    },
  };
});

const service = await import('./service');
const { syncFromCrm } = service;

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
  db.spans = [];
  db.crm = { actions: [], taches: [] };
  db.crmLog = [];
  db.crmDown = false;
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

/** Une tâche du calendrier du CRM, telle que la route la donne. */
const tache = (partial: Partial<CrmTache>): CrmTache => ({
  id: 't-video',
  titre: 'Tourner la vidéo coachs',
  note: null,
  jour: today,
  heure: '15:00',
  duree_minutes: 30,
  responsable: 'Loys',
  lead_id: null,
  lead_nom: null,
  lead_cabinet: null,
  lead_telephone: null,
  ...partial,
});

/** Cinq minutes plus tard : la synchro suivante. */
const later = () => vi.advanceTimersByTimeAsync(5 * 60_000);

describe('calendrier du CRM et Discord, dans les deux sens', () => {
  it('une tâche du calendrier arrive chez son responsable, et se coche quand le CRM la coche', async () => {
    const loys = published('Loys');
    const enzo = published('Enzo');
    db.crm.taches.push(tache({}));
    await syncFromCrm(client);
    expect(rowsOf(loys)).toEqual([
      expect.objectContaining({
        record_id: 'tache:t-video',
        label: 'Tourner la vidéo coachs',
        due_time: '15:00',
        is_done: false,
      }),
    ]);
    expect(rowsOf(enzo)).toEqual([]);

    db.crm.taches[0]!.fait = true;
    await later();
    await syncFromCrm(client);
    expect(rowsOf(loys)[0]).toMatchObject({ is_done: true, done_by: 'CRM' });
  });

  it('cochée sur Discord, elle l’est dans le CRM ; une lecture commencée avant ne la décoche pas', async () => {
    const loys = published('Loys');
    published('Enzo');
    db.crm.taches.push(tache({}));
    const before = Date.now();
    await syncFromCrm(client);
    await later();
    const row = rowsOf(loys)[0]!;
    await service.toggleTasks(client, loys, [row.id], 'Loys');
    expect(db.crmLog).toEqual([['modifier', 't-video', { fait: true }]]);
    expect(row.is_done).toBe(true);

    // Une lecture partie avant le clic dit encore « pas faite » : on ne la croit pas.
    const { buildCrmAgenda } = await import('./crm');
    const stale = { ...buildCrmAgenda(db.crm, today), readAt: before };
    await service.reconcile(loys, stale);
    expect(row.is_done).toBe(true);
  });

  it('ajoutée sur Discord, elle va dans le calendrier du CRM, sans doublon ni annonce', async () => {
    const enzo = published('Enzo');
    published('Loys');
    await syncFromCrm(client);
    await later();

    await service.planTask(client, enzo, today, 'Envoyer la brochure à Théo', '15:00');
    expect(db.crmLog).toEqual([
      [
        'creer',
        { titre: 'Envoyer la brochure à Théo', jour: today, heure: '15:00', responsable: 'Enzo' },
      ],
    ]);
    expect(rowsOf(enzo)).toEqual([
      expect.objectContaining({ record_id: 'tache:t1', label: 'Envoyer la brochure à Théo' }),
    ]);

    // Le CRM la contient maintenant : la synchro suivante la retrouve, sans la doubler ni l'annoncer.
    db.crm.taches.push(
      tache({ id: 't1', titre: 'Envoyer la brochure à Théo', responsable: 'Enzo' }),
    );
    sent.length = 0;
    await later();
    await syncFromCrm(client);
    expect(rowsOf(enzo).map((t) => t.label)).toEqual(['Envoyer la brochure à Théo']);
    expect(sent.filter((s) => s.content.startsWith('Agenda mis à jour'))).toEqual([]);
  });

  it('sans réponse du CRM, rien n’est ajouté ni coché, et la personne le voit', async () => {
    const loys = published('Loys');
    published('Enzo');
    db.crm.taches.push(tache({}));
    await syncFromCrm(client);
    db.crmDown = true;
    await expect(
      service.planTask(client, loys, today, 'Appeler le comptable', null),
    ).rejects.toThrow(/CRM n’a pas répondu/);
    const row = rowsOf(loys)[0]!;
    await expect(service.toggleTasks(client, loys, [row.id], 'Loys')).rejects.toThrow(
      /CRM n’a pas répondu/,
    );
    expect(rowsOf(loys)).toHaveLength(1);
    expect(row.is_done).toBe(false);
  });

  it('retirée sur Discord, elle est supprimée du calendrier du CRM', async () => {
    const loys = published('Loys');
    published('Enzo');
    db.crm.taches.push(tache({}));
    await syncFromCrm(client);
    await service.removeTasks(client, loys, [rowsOf(loys)[0]!.id]);
    expect(db.crmLog).toEqual([['supprimer', 't-video']]);
    expect(rowsOf(loys)).toEqual([]);
  });

  it('reportée le soir, elle change de jour dans le CRM', async () => {
    const loys = published('Loys');
    published('Enzo');
    db.crm.taches.push(tache({}));
    await syncFromCrm(client);
    const row = rowsOf(loys)[0]!;
    await service.toggleCarry(client, loys, [row.id]);
    expect(db.crmLog).toEqual([['modifier', 't-video', { jour: '2026-10-29' }]]);
    expect(row.signature?.endsWith('|2026-10-29')).toBe(true);
    expect(rowsOf(loys)).toEqual([]);
  });

  it('une tâche permanente du CRM est une tâche permanente de Discord, jusqu’à ce qu’elle soit faite', async () => {
    const enzo = published('Enzo');
    published('Loys');
    db.crm.taches.push(
      tache({
        id: 't-devis',
        titre: 'Relancer les devis',
        responsable: 'Enzo',
        jour: '2026-10-27',
        heure: null,
        permanente: true,
      }),
    );
    await syncFromCrm(client);
    expect(db.spans).toEqual([
      expect.objectContaining({
        crm_ref: 't-devis',
        kind: 'permanent',
        person: 'Enzo',
        shared: false,
        label: 'Relancer les devis',
      }),
    ]);
    expect(rowsOf(enzo).map((t) => t.label)).toEqual(['Relancer les devis']);

    db.crm.taches[0]!.fait = true;
    await later();
    await syncFromCrm(client);
    expect(db.spans[0]).toMatchObject({ done_by: 'CRM' });
    expect(db.spans[0]!.done_at).not.toBeNull();
  });

  it('une période sans responsable est pour toute l’équipe ; supprimée du CRM, elle part', async () => {
    const loys = published('Loys');
    const enzo = published('Enzo');
    db.crm.taches.push(
      tache({
        id: 't-salon',
        titre: 'Salon de l’habitat',
        responsable: null,
        heure: '09:00',
        fin_jour: '2026-10-30',
        fin_heure: '19:00',
      }),
    );
    await syncFromCrm(client);
    expect(db.spans).toEqual([
      expect.objectContaining({
        crm_ref: 't-salon',
        kind: 'period',
        shared: true,
        end_date: '2026-10-30',
        end_time: '19:00',
      }),
    ]);
    expect(rowsOf(loys).map((t) => t.label)).toEqual(['Salon de l’habitat']);
    expect(rowsOf(enzo).map((t) => t.label)).toEqual(['Salon de l’habitat']);

    db.crm.taches = [];
    await later();
    await syncFromCrm(client);
    expect(db.spans[0]!.dismissed_at).not.toBeNull();
    expect(rowsOf(loys)).toEqual([]);
  });

  it('créée sur Discord pour les deux, une tâche permanente va dans le CRM sans responsable', async () => {
    const loys = published('Loys');
    published('Enzo');
    await service.createSpan(client, loys, {
      kind: 'permanent',
      shared: true,
      label: 'Publier un reel',
      start: { date: today, time: null },
      end: null,
    });
    expect(db.crmLog).toEqual([
      [
        'creer',
        {
          titre: 'Publier un reel',
          jour: today,
          heure: null,
          responsable: null,
          permanente: true,
          fin_jour: null,
          fin_heure: null,
        },
      ],
    ]);
    expect(db.spans).toEqual([expect.objectContaining({ crm_ref: 't1', shared: true })]);

    // Relue dans le CRM, c'est la même : pas de seconde tâche.
    db.crm.taches.push(
      tache({
        id: 't1',
        titre: 'Publier un reel',
        responsable: null,
        heure: null,
        permanente: true,
      }),
    );
    await later();
    await syncFromCrm(client);
    expect(db.spans).toHaveLength(1);
  });
});
