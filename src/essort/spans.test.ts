import { describe, expect, it } from 'vitest';
import type { EssortBoardRow, EssortSpanRow } from '../db/essortRepository';
import {
  atParis,
  parseMomentInput,
  periodProblem,
  spanClosedText,
  spanDetails,
  spanRowTime,
  spanShowsOn,
  spanWeekLines,
} from './spans';
import {
  buildPlanDayMenu,
  buildSpanEditModal,
  buildSpanQuestion,
  buildSpanReportModal,
  buildUnplanMenu,
} from './ui';

const today = '2026-10-16'; // un vendredi

function span(partial: Partial<EssortSpanRow> = {}): EssortSpanRow {
  return {
    id: 5,
    person: 'Loys',
    channel_id: 'c',
    kind: 'period',
    label: 'Préparer la présentation',
    start_date: '2026-10-19',
    start_time: '09:00',
    end_date: '2026-10-21',
    end_time: '18:00',
    done_at: null,
    done_by: null,
    dismissed_at: null,
    asked_at: null,
    ask_message_id: null,
    created_at: '',
    ...partial,
  };
}

describe('jour et heure tapés à la main', () => {
  it('comprend un jour, une heure, ou les deux', () => {
    expect(parseMomentInput('lundi 9h', today)).toEqual({ date: '2026-10-19', time: '09:00' });
    expect(parseMomentInput('20/10 14h30', today)).toEqual({ date: '2026-10-20', time: '14:30' });
    expect(parseMomentInput('demain à 18:00', today)).toEqual({
      date: '2026-10-17',
      time: '18:00',
    });
    expect(parseMomentInput('Mardi 20/10 09:00', today)).toEqual({
      date: '2026-10-20',
      time: '09:00',
    });
    expect(parseMomentInput('14h', today)).toEqual({ date: today, time: '14:00' });
    expect(parseMomentInput('mercredi', today)).toEqual({ date: '2026-10-21', time: null });
  });

  it('vide : rien ; illisible : refusé, heure comprise', () => {
    expect(parseMomentInput('  ', today)).toBeNull();
    expect(parseMomentInput('bientôt', today)).toBeUndefined();
    expect(parseMomentInput('lundi 25h', today)).toBeUndefined();
    expect(parseMomentInput('lundi 9h du matin', today)).toBeUndefined();
  });
});

describe('créneau d’une période', () => {
  const now = atParis(today, '10:00');

  it('accepte un créneau à venir, fin sans heure comprise', () => {
    const start = { date: today, time: null };
    expect(periodProblem(start, { date: '2026-10-21', time: '18:00' }, today, now)).toBeNull();
    expect(periodProblem(start, { date: today, time: null }, today, now)).toBeNull();
  });

  it('refuse un début passé, une fin passée ou une fin avant le début', () => {
    const end = { date: '2026-10-21', time: '18:00' };
    expect(periodProblem({ date: '2026-10-15', time: null }, end, today, now)).toBe(
      'Le début est déjà passé.',
    );
    expect(
      periodProblem({ date: today, time: null }, { date: today, time: '09:00' }, today, now),
    ).toBe('La fin est déjà passée.');
    expect(periodProblem({ date: '2026-10-21', time: '19:00' }, end, today, now)).toBe(
      'La fin doit venir après le début.',
    );
  });

  it('en modification, le début déjà enregistré peut être passé', () => {
    const kept = { date: '2026-10-14', time: '09:00' };
    expect(periodProblem(kept, { date: '2026-10-20', time: null }, today, now, kept)).toBeNull();
  });
});

describe('sur quels tableaux une tâche s’affiche', () => {
  it('une période : chaque jour du créneau, l’heure de début le premier jour', () => {
    const s = span();
    expect(
      ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'].map((d) =>
        spanShowsOn(s, d),
      ),
    ).toEqual([false, true, true, true, false]);
    expect(spanRowTime(s, '2026-10-19')).toBe('09:00');
    expect(spanRowTime(s, '2026-10-20')).toBeNull();
    expect(spanDetails(s, '2026-10-19')).toBe('Jusqu’au mercredi 21/10, 18:00');
    expect(spanDetails(s, '2026-10-21')).toBe('Jusqu’à 18:00');
  });

  it('une tâche permanente : chaque jour jusqu’à être faite ou retirée', () => {
    const s = span({ kind: 'permanent', start_time: null, end_date: null, end_time: null });
    expect(spanShowsOn(s, '2026-10-19')).toBe(true);
    expect(spanShowsOn(s, '2027-01-04')).toBe(true);
    expect(spanShowsOn(s, '2026-10-18')).toBe(false);
    expect(spanShowsOn({ ...s, done_at: 'x' }, '2026-10-20')).toBe(false);
    expect(spanShowsOn({ ...s, dismissed_at: 'x' }, '2026-10-20')).toBe(false);
    expect(spanDetails(s, '2026-10-20')).toBe('Tous les jours, jusqu’à ce qu’elle soit faite');
  });

  it('la semaine montre le début et la fin d’une période, rien d’une permanente', () => {
    expect(spanWeekLines(span(), '2026-10-17', '2026-10-22')).toEqual([
      {
        date: '2026-10-19',
        time: '09:00',
        label: 'Préparer la présentation (jusqu’au mer. 21/10 18:00)',
      },
      { date: '2026-10-21', time: '18:00', label: 'Fin : Préparer la présentation' },
    ]);
    // Déjà commencée : seule la fin est à venir.
    expect(spanWeekLines(span(), '2026-10-20', '2026-10-25')).toHaveLength(1);
    expect(spanWeekLines(span({ kind: 'permanent' }), '2026-10-17', '2026-10-22')).toEqual([]);
  });
});

describe('messages des tâches sur plusieurs jours', () => {
  const board = { id: 1, person: 'Loys', board_date: today, archived_at: null } as EssortBoardRow;

  it('« Planifier » propose tous les jours et une période avant les jours', () => {
    const menu = buildPlanDayMenu(board).toJSON().components[0] as {
      options: { label: string; value: string }[];
    };
    expect(menu.options).toHaveLength(25);
    expect(menu.options.slice(0, 3).map((o) => o.value)).toEqual(['permanent', 'period', today]);
    expect(menu.options[24]!.value).toBe('2026-11-07');
  });

  it('la question de fin : faite, reporter ou abandonner, sans dépendre d’un tableau', () => {
    const q = buildSpanQuestion(span(), '<@1>');
    expect(q.content).toBe(
      '<@1> Fin de la période : **Préparer la présentation** (du lun. 19/10 09:00 au mer. 21/10 18:00). Elle a pu être faite ?',
    );
    const buttons = q.components[0]!.toJSON().components as { custom_id: string; label: string }[];
    expect(buttons.map((b) => [b.custom_id, b.label])).toEqual([
      ['essort:spandone:5', 'Faite'],
      ['essort:spanmore:5', 'Reporter'],
      ['essort:spandrop:5', 'Abandonner'],
    ]);
  });

  it('« Reporter » propose le lendemain à la même heure, et se relit', () => {
    const modal = buildSpanReportModal(span(), '2026-10-21').toJSON();
    expect(modal.custom_id).toBe('essort:spanmoremodal:5');
    const value = (modal.components[0]!.components[0] as { value?: string }).value!;
    expect(value).toBe('Jeudi 22/10 18:00');
    expect(parseMomentInput(value, '2026-10-21')).toEqual({ date: '2026-10-22', time: '18:00' });
  });

  it('le formulaire de modification est prérempli et se relit tel quel', () => {
    const modal = buildSpanEditModal(1, span()).toJSON();
    expect(modal.custom_id).toBe('essort:spaneditmodal:1:5');
    const values = modal.components.map((r) => (r.components[0] as { value?: string }).value);
    expect(values).toEqual([
      'Préparer la présentation',
      'Lundi 19/10 09:00',
      'Mercredi 21/10 18:00',
    ]);
    expect(parseMomentInput(values[1]!, today)).toEqual({ date: '2026-10-19', time: '09:00' });
    const permanent = buildSpanEditModal(1, span({ kind: 'permanent' })).toJSON();
    expect(permanent.components).toHaveLength(1);
  });

  it('« Retirer » de la semaine liste aussi les périodes à venir', () => {
    const menu = buildUnplanMenu(board, [], [span()]).toJSON().components[0] as {
      options: { value: string; description: string }[];
    };
    expect(menu.options[0]).toMatchObject({
      value: 'span:5',
      description: 'Du lun. 19/10 09:00 au mer. 21/10 18:00',
    });
  });

  it('la question close ne garde que la réponse', () => {
    expect(spanClosedText(span(), 'done', 'Loys')).toBe(
      '✅ Faite : **Préparer la présentation** (Loys)',
    );
    expect(spanClosedText(span({ end_date: '2026-10-22' }), 'report', 'Enzo')).toBe(
      'Reportée au jeu. 22/10 18:00 : **Préparer la présentation** (Enzo)',
    );
    expect(spanClosedText(span(), 'drop', null)).toBe('Abandonnée : **Préparer la présentation**');
  });
});
