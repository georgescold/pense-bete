import { describe, expect, it } from 'vitest';
import type { EssortBoardRow, EssortTaskRow } from '../db/essortRepository';
import {
  buildDayComponents,
  buildDayEmbed,
  buildPlanDayMenu,
  buildWeekComponents,
  buildWeekEmbed,
  dayIntro,
  dayOrder,
} from './ui';
import { parseTimeInput } from './planner';

function board(partial: Partial<EssortBoardRow> = {}): EssortBoardRow {
  return {
    id: 1,
    person: 'Enzo',
    board_date: '2026-10-08',
    channel_id: 'c',
    message_id: null,
    week_message_id: null,
    extras: {},
    read_at: '2026-10-08T04:00:00Z',
    archived_at: null,
    created_at: '',
    ...partial,
  };
}

function task(id: number, partial: Partial<EssortTaskRow> = {}): EssortTaskRow {
  return {
    id,
    board_id: 1,
    source: 'airtable',
    record_id: 'recABCDEFGHIJKLMN',
    signature: 'a call|2026-10-08',
    label: `Appeler Prénom Nom ${id} · Cabinet d’architecture au nom assez long`,
    details: `${'Rappel prévu en fin de matinée, préparer le devis et les références '.repeat(2)} · ☎ 06 00 00 00 00`,
    due_time: null,
    pinged_at: null,
    position: id,
    is_done: false,
    done_at: null,
    done_by: null,
    dismissed_at: null,
    sheet_range: null,
    created_at: '',
    ...partial,
  };
}

/** Somme des textes comptés par Discord pour la limite de 6 000 caractères. */
function embedSize(json: ReturnType<ReturnType<typeof buildDayEmbed>['toJSON']>): number {
  return (
    (json.title?.length ?? 0) +
    (json.description?.length ?? 0) +
    (json.footer?.text.length ?? 0) +
    (json.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

describe('message du jour', () => {
  it('reste sous les limites de Discord même chargé', () => {
    const tasks = Array.from({ length: 25 }, (_, i) => task(i + 1));
    const reminders = Array.from({ length: 40 }, (_, i) => ({
      time: '09:00',
      label: `Rappel ${i}`,
    }));
    const json = buildDayEmbed(
      board({ extras: { airtableError: true } }),
      tasks,
      reminders,
    ).toJSON();
    expect(json.description!.length).toBeLessThanOrEqual(4096);
    for (const f of json.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(embedSize(json)).toBeLessThanOrEqual(6000);
  });

  it('n’affiche que la tâche, son heure et sa consigne', () => {
    const json = buildDayEmbed(board(), [
      task(1, { details: 'Jeudi 11h · ☎ 06', due_time: '11:00', label: 'Appeler Paul' }),
    ]).toJSON();
    expect(json.description).toContain('1. `11:00` **Appeler Paul**\n   - Jeudi 11h · ☎ 06');
    expect(json.description).not.toContain('airtable.com');
    expect(json.footer).toBeUndefined();
    expect(json.author).toBeUndefined();
  });

  it('barre une tâche faite sans ses détails', () => {
    const json = buildDayEmbed(board(), [task(1, { is_done: true, label: 'Fait' })]).toJSON();
    expect(json.description).toContain('1. ~~Fait~~');
    expect(json.description).not.toContain('   - ');
  });

  it('liste les rappels du jour à part', () => {
    const json = buildDayEmbed(board(), [], [{ time: '09:00', label: 'Sport' }]).toJSON();
    expect(json.fields).toEqual([{ name: '⏰ Rappels', value: '- `09:00` Sport' }]);
  });

  it('range les heures fixes en premier', () => {
    const ordered = dayOrder([
      task(1, { position: 0 }),
      task(2, { position: 1, due_time: '14:00' }),
      task(3, { position: 2, due_time: '09:30' }),
    ]);
    expect(ordered.map((t) => t.id)).toEqual([3, 2, 1]);
  });

  it('ne laisse aucun bouton sur un jour passé', () => {
    expect(buildDayComponents(board({ archived_at: '2026-10-09T04:00:00Z' }), [task(1)])).toEqual(
      [],
    );
  });

  it('tient dans les 5 lignes de Discord au-delà de 20 tâches', () => {
    const tasks = Array.from({ length: 30 }, (_, i) => task(i + 1));
    expect(buildDayComponents(board(), tasks).length).toBeLessThanOrEqual(5);
  });
});

describe('dayIntro', () => {
  it('mentionne toujours la personne', () => {
    expect(dayIntro('<@1>', 2, 3)).toBe('<@1> 2 tâches aujourd’hui.');
    expect(dayIntro('<@1>', 1, 1)).toBe('<@1> 1 tâche aujourd’hui.');
    expect(dayIntro('<@1>', 0, 3)).toBe('<@1> Tout est fait aujourd’hui. ✅');
    expect(dayIntro('<@1>', 0, 0)).toBe('<@1> Rien de prévu aujourd’hui.');
    expect(dayIntro(null, 0, 0)).toBe('Rien de prévu aujourd’hui.');
  });
});

describe('message de la semaine', () => {
  it('présente les 6 jours suivants, sans aujourd’hui, triés par heure', () => {
    const json = buildWeekEmbed(board(), [
      { date: '2026-10-09', time: '14:00', label: 'R1 avec Dina', kind: 'airtable' },
      { date: '2026-10-09', time: '09:00', label: 'Sport', kind: 'reminder' },
      { date: '2026-10-12', time: null, label: 'Préparer le devis', kind: 'planned' },
      { date: '2026-10-08', time: null, label: 'Aujourd’hui : pas ici', kind: 'planned' },
    ]).toJSON();
    expect(json.title).toBe('📅 Ta semaine · ven. 09/10 → mer. 14/10');
    expect(json.description).toContain(
      '**Vendredi 09/10**\n- `09:00` Sport (rappel)\n- `14:00` R1 avec Dina',
    );
    expect(json.description).toContain('**Samedi 10/10**\n*Rien de prévu*');
    expect(json.description).toContain('**Lundi 12/10**\n- Préparer le devis');
    expect(json.description).not.toContain('Jeudi 08/10');
    expect(json.description).not.toContain('pas ici');
  });

  it('propose de planifier, retirer, gérer les rappels et actualiser', () => {
    const [row] = buildWeekComponents(board(), 0).map((r) => r.toJSON());
    const buttons = row!.components as { label?: string; disabled?: boolean }[];
    expect(buttons.map((c) => [c.label, Boolean(c.disabled)])).toEqual([
      ['Planifier', false],
      ['Retirer', true],
      ['Rappels', false],
      ['Actualiser', false],
    ]);
    expect(buildWeekComponents(board({ archived_at: 'x' }), 3)).toEqual([]);
  });

  it('planifie d’aujourd’hui à J+24', () => {
    const menu = buildPlanDayMenu(board()).toJSON().components[0] as {
      options: { label: string; value: string }[];
    };
    expect(menu.options).toHaveLength(25);
    expect(menu.options[0]).toEqual({ label: 'Aujourd’hui (08/10)', value: '2026-10-08' });
    expect(menu.options[1]).toEqual({ label: 'Demain (09/10)', value: '2026-10-09' });
    expect(menu.options[24]!.value).toBe('2026-11-01');
  });
});

describe('parseTimeInput', () => {
  it('lit les heures tapées à la main', () => {
    expect(parseTimeInput('14h30')).toBe('14:30');
    expect(parseTimeInput('9h')).toBe('09:00');
    expect(parseTimeInput(' 14:05 ')).toBe('14:05');
    expect(parseTimeInput('9')).toBe('09:00');
    expect(parseTimeInput('')).toBeNull();
    expect(parseTimeInput('25h')).toBeUndefined();
    expect(parseTimeInput('demain')).toBeUndefined();
  });
});
