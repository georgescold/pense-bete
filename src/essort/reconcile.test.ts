import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EssortBoardRow, EssortTaskRow } from '../db/essortRepository';
import type { Lead } from './airtable';
import { buildAgenda, restatesPastAction } from './planner';

// Base en mémoire à la place de Supabase.
const store = vi.hoisted(() => ({ tasks: [] as EssortTaskRow[], nextId: 1 }));

vi.mock('../db/essortRepository', () => ({
  listTasks: async (boardId: number, includeDismissed = false) =>
    store.tasks.filter((t) => t.board_id === boardId && (includeDismissed || !t.dismissed_at)),
  listAirtableTasksFor: async (ids: string[]) =>
    store.tasks.filter((t) => t.source === 'airtable' && ids.includes(t.record_id ?? '')),
  addTask: async (task: Partial<EssortTaskRow>) => {
    const row = {
      id: store.nextId++,
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
      sheet_range: null,
      created_at: '',
      ...task,
    } as EssortTaskRow;
    store.tasks.push(row);
    return row;
  },
  updateTask: async (id: number, patch: Partial<EssortTaskRow>) => {
    const row = store.tasks.find((t) => t.id === id);
    if (row) Object.assign(row, patch);
    return row ?? null;
  },
  deleteTask: async (id: number) => {
    store.tasks = store.tasks.filter((t) => t.id !== id);
  },
  updateBoard: async () => null,
}));

const { reconcile } = await import('./service');

const eloise: Lead = {
  id: 'recEloise',
  email: null,
  nom: 'Éloïse Fiat',
  type: 'Demande',
  telephone: null,
  cabinet: null,
  qualite: null,
  verdict: null,
  action: 'R2',
  gestion: 'Enzo',
  prochainEvenement: null,
  dateAction: '2026-10-14',
};

const board = (id: number, date: string) =>
  ({ id, person: 'Enzo', board_date: date, extras: {} }) as EssortBoardRow;

function manual(boardId: number, label: string): EssortTaskRow {
  const row = {
    id: store.nextId++,
    board_id: boardId,
    source: 'manual',
    label,
    due_time: '14:00',
    is_done: false,
    dismissed_at: null,
  } as EssortTaskRow;
  store.tasks.push(row);
  return row;
}

const visible = (boardId: number) =>
  store.tasks.filter((t) => t.board_id === boardId && !t.dismissed_at).map((t) => t.label);

describe('action du CRM couverte par une tâche écrite à la main', () => {
  beforeEach(() => {
    store.tasks = [];
    store.nextId = 1;
  });

  it('ne revient pas « en retard » le lendemain si la tâche écrite n’est ni faite ni reportée', async () => {
    manual(14, 'Visio Éloïse Fiat');
    await reconcile(board(14, '2026-10-14'), buildAgenda([eloise], '2026-10-14'));
    expect(visible(14)).toEqual(['Visio Éloïse Fiat']);

    await reconcile(board(15, '2026-10-15'), buildAgenda([eloise], '2026-10-15'));
    expect(visible(15)).toEqual([]);
  });

  it('une copie déjà sur le tableau est masquée, pas effacée', async () => {
    await reconcile(board(14, '2026-10-14'), buildAgenda([eloise], '2026-10-14'));
    expect(visible(14)).toEqual(['R2 avec Éloïse Fiat']);
    manual(14, 'Visio Éloïse Fiat');
    await reconcile(board(14, '2026-10-14'), buildAgenda([eloise], '2026-10-14'));
    expect(visible(14)).toEqual(['Visio Éloïse Fiat']);
    expect(store.tasks.filter((t) => t.source === 'airtable')).toHaveLength(1);

    await reconcile(board(15, '2026-10-15'), buildAgenda([eloise], '2026-10-15'));
    expect(visible(15)).toEqual([]);
  });

  it('sans tâche écrite, l’action passée sans être faite ne revient pas non plus', async () => {
    await reconcile(board(14, '2026-10-14'), buildAgenda([eloise], '2026-10-14'));
    await reconcile(board(15, '2026-10-15'), buildAgenda([eloise], '2026-10-15'));
    expect(visible(15)).toEqual([]);
  });
});

describe('seule l’Action change dans le CRM, sur un jour passé', () => {
  const marie: Lead = { ...eloise, id: 'recMarie', nom: 'Marie Lennon', dateAction: '2026-10-16' };

  beforeEach(() => {
    store.tasks = [];
    store.nextId = 1;
  });

  it('« R2 » devenu « Attente de doc » sans nouvelle date : rien ne revient', async () => {
    await reconcile(board(16, '2026-10-16'), buildAgenda([marie], '2026-10-16'));
    expect(visible(16)).toEqual(['R2 avec Marie Lennon']);

    const waiting = { ...marie, action: 'Attente de doc' };
    await reconcile(board(18, '2026-10-18'), buildAgenda([waiting], '2026-10-18'));
    expect(visible(18)).toEqual([]);
  });

  it('une nouvelle date ramène le lead', async () => {
    await reconcile(board(16, '2026-10-16'), buildAgenda([marie], '2026-10-16'));
    const later = { ...marie, action: 'Attente de doc', dateAction: '2026-10-18' };
    await reconcile(board(18, '2026-10-18'), buildAgenda([later], '2026-10-18'));
    expect(visible(18)).toHaveLength(1);
  });

  it('une action passée jamais vue arrive toujours, en retard', async () => {
    await reconcile(board(18, '2026-10-18'), buildAgenda([marie], '2026-10-18'));
    expect(visible(18)).toEqual(['R2 avec Marie Lennon']);
  });

  it('ni annonce : seul un jour passé déjà traité sous une autre Action compte', () => {
    const handled = [{ record_id: 'recMarie', signature: 'r2|2026-10-16' }];
    const restated = {
      recordId: 'recMarie',
      signature: 'attente de doc|2026-10-16',
      date: '2026-10-16',
    };
    expect(restatesPastAction(restated, handled, '2026-10-18')).toBe(true);
    // Même jour qu'aujourd'hui, autre lead, autre jour : une vraie action.
    expect(restatesPastAction(restated, handled, '2026-10-16')).toBe(false);
    expect(restatesPastAction({ ...restated, recordId: 'recAutre' }, handled, '2026-10-18')).toBe(
      false,
    );
    expect(
      restatesPastAction(
        { ...restated, signature: 'attente de doc|2026-10-15', date: '2026-10-15' },
        handled,
        '2026-10-18',
      ),
    ).toBe(false);
  });
});
