import { describe, expect, it } from 'vitest';
import type { EssortTaskRow, TaskWithBoard } from '../db/essortRepository';
import type { CalendarEvent } from '../lib/calendar';
import type { Lead } from './airtable';
import { eventBody, planCalendar, wantedEvents, type WantedEvent } from './calendarSync';
import { addDays, buildAgenda } from './planner';

const TODAY = '2026-10-13';
const UNTIL = addDays(TODAY, 90);

function lead(partial: Partial<Lead>): Lead {
  return {
    id: 'recTEST',
    email: null,
    nom: null,
    type: 'Demande',
    telephone: null,
    cabinet: null,
    qualite: null,
    verdict: null,
    action: null,
    gestion: null,
    prochainEvenement: null,
    dateAction: null,
    ...partial,
  };
}

const LEADS: Lead[] = [
  lead({
    id: 'recVincent',
    nom: 'Vincent Gillot',
    action: 'R2',
    gestion: 'Loys',
    prochainEvenement: 'Mar. 13/10 à 14 h · R2 · document à préparer',
    dateAction: '2026-10-13',
  }),
  lead({
    id: 'recFrancesco',
    nom: 'Francesco Girardi',
    cabinet: 'Continuo Architecture',
    action: 'R1',
    gestion: 'Enzo',
    prochainEvenement: 'Mer. 14/10 à 17 h · R1 · Enzo appelle Francesco',
    dateAction: '2026-10-14',
  }),
  // Le texte parle encore d'un jour passé : pas d'heure, donc pas d'agenda.
  lead({
    id: 'recEloise',
    nom: 'Éloïse Fiat',
    action: 'R2',
    gestion: 'Enzo',
    prochainEvenement: 'Vendredi 09/10 à 14h appel téléphonique',
    dateAction: '2026-10-14',
  }),
  lead({
    id: 'recRelance',
    nom: 'Paul Durand',
    action: 'A relancer',
    gestion: 'Loys',
    prochainEvenement: 'Relancer le 20/10',
    dateAction: '2026-10-20',
  }),
  lead({
    id: 'recDead',
    nom: 'Corinne',
    action: 'dead',
    gestion: 'Loys',
    prochainEvenement: 'Rappeler mardi 13/10 à 9h',
    dateAction: '2026-10-13',
  }),
];

const AGENDA = buildAgenda(LEADS, TODAY);

let nextId = 1;
function task(
  partial: Partial<EssortTaskRow> & { date: string; person?: 'Loys' | 'Enzo' },
): TaskWithBoard {
  const { date, person = 'Enzo', ...rest } = partial;
  return {
    id: nextId++,
    board_id: 1,
    source: 'manual',
    record_id: null,
    signature: null,
    label: 'Tâche',
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
    created_at: '2026-10-13T06:00:00Z',
    essort_boards: { person, board_date: date },
    ...rest,
  };
}

const summary = (w: WantedEvent[]) => w.map((e) => `${e.date} ${e.time} ${e.person} ${e.key}`);

describe('agenda Google : ce qui doit y être', () => {
  it('les rendez-vous du CRM, à l’heure ou en attente d’heure ; pas les relances ni les leads morts', () => {
    expect(summary(wantedEvents(AGENDA, [], [], TODAY, UNTIL))).toEqual([
      '2026-10-13 14:00 Loys crm:recVincent|r2|2026-10-13',
      '2026-10-14 null Enzo crm:recEloise|r2|2026-10-14',
      '2026-10-14 17:00 Enzo crm:recFrancesco|r1|2026-10-14',
    ]);
  });

  it('une tâche Discord avec une heure y va ; sans heure, seulement un rendez-vous', () => {
    const tasks = [
      task({ date: '2026-10-15', label: 'Visio Paul Martin', due_time: '11:00' }),
      task({ date: '2026-10-15', label: 'rdv Anne Lemoine' }),
      task({ date: '2026-10-15', label: 'Envoyer le devis' }),
    ];
    const wanted = wantedEvents(AGENDA, tasks, [], TODAY, UNTIL);
    expect(summary(wanted).filter((w) => w.includes('task:'))).toEqual([
      `2026-10-15 null Enzo task:${tasks[1]!.id}`,
      `2026-10-15 11:00 Enzo task:${tasks[0]!.id}`,
    ]);
  });

  it('une tâche écrite à la main qui est déjà l’action du CRM l’emporte', () => {
    const manual = task({ date: '2026-10-14', label: 'rdv Francesco', due_time: '17:00' });
    const wanted = wantedEvents(AGENDA, [manual], [], TODAY, UNTIL);
    expect(summary(wanted)).toEqual([
      '2026-10-13 14:00 Loys crm:recVincent|r2|2026-10-13',
      '2026-10-14 null Enzo crm:recEloise|r2|2026-10-14',
      `2026-10-14 17:00 Enzo task:${manual.id}`,
    ]);
    expect(wanted[2]!.names).toEqual(['francesco']);
  });

  it('une action modifiée sur Discord garde sa clé et prend la nouvelle heure', () => {
    const moved = task({
      date: TODAY,
      person: 'Loys',
      source: 'airtable',
      record_id: 'recVincent',
      signature: 'r2|2026-10-13',
      label: 'R2 avec Vincent Gillot',
      due_time: '15:30',
      edited_at: '2026-10-13T08:00:00Z',
    });
    const wanted = wantedEvents(AGENDA, [moved], [moved], TODAY, UNTIL);
    expect(summary(wanted)[0]).toBe('2026-10-13 15:30 Loys crm:recVincent|r2|2026-10-13');
    expect(wanted[0]!.names).toEqual(['vincent', 'gillot']);
  });

  it('une action retirée sur Discord sort de l’agenda', () => {
    const removed = task({
      date: TODAY,
      person: 'Loys',
      source: 'airtable',
      record_id: 'recVincent',
      signature: 'r2|2026-10-13',
      due_time: '14:00',
      dismissed_at: '2026-10-13T09:00:00Z',
    });
    expect(summary(wantedEvents(AGENDA, [], [removed], TODAY, UNTIL))).toEqual([
      '2026-10-14 null Enzo crm:recEloise|r2|2026-10-14',
      '2026-10-14 17:00 Enzo crm:recFrancesco|r1|2026-10-14',
    ]);
  });

  it('rien avant aujourd’hui ni au-delà de la fenêtre', () => {
    const tasks = [
      task({ date: '2026-10-12', label: 'Hier', due_time: '10:00' }),
      task({ date: UNTIL, label: 'Trop loin', due_time: '10:00' }),
    ];
    const labels = wantedEvents(AGENDA, tasks, [], TODAY, UNTIL).map((w) => w.label);
    expect(labels).not.toContain('Hier');
    expect(labels).not.toContain('Trop loin');
  });
});

describe('agenda Google : ce qu’il faut écrire', () => {
  const vincent: WantedEvent = {
    key: 'crm:recVincent|r2|2026-10-13',
    person: 'Loys',
    date: TODAY,
    time: '14:00',
    label: 'R2 avec Vincent Gillot',
    details: 'Document à préparer',
    recordId: 'recVincent',
    names: ['vincent', 'gillot'],
  };
  const eloise: WantedEvent = {
    key: 'crm:recEloise|r2|2026-10-14',
    person: 'Enzo',
    date: '2026-10-14',
    time: null,
    label: 'R2 avec Éloïse Fiat',
    details: null,
    recordId: 'recEloise',
    names: ['eloise', 'fiat'],
  };
  const ours = (id: string, w: WantedEvent): CalendarEvent => ({ id, ...eventBody(w, 60) });

  it('l’événement est à Paris, d’une heure, marqué comme écrit par le bot', () => {
    const body = eventBody(vincent, 60);
    expect(body.start?.dateTime).toBe('2026-10-13T12:00:00.000Z');
    expect(body.end?.dateTime).toBe('2026-10-13T13:00:00.000Z');
    expect(body.summary).toBe('R2 avec Vincent Gillot · Loys');
    expect(body.extendedProperties?.private?.essortKey).toBe(vincent.key);
    expect(body.description).toContain('Document à préparer');
  });

  it('sans heure : toute la journée, en attente de son créneau', () => {
    const body = eventBody(eloise, 60);
    expect(body.start).toEqual({ date: '2026-10-14' });
    expect(body.end).toEqual({ date: '2026-10-15' });
    expect(body.summary).toBe('R2 avec Éloïse Fiat · Enzo · heure à fixer');
  });

  it('crée ce qui manque, laisse ce qui est à jour', () => {
    expect(planCalendar([vincent], [], 60, TODAY).create).toHaveLength(1);
    expect(planCalendar([vincent], [ours('e1', vincent)], 60, TODAY)).toEqual({
      create: [],
      update: [],
      remove: [],
    });
  });

  it('déplace l’événement quand l’heure change', () => {
    const changes = planCalendar([{ ...vincent, time: '15:00' }], [ours('e1', vincent)], 60, TODAY);
    expect(changes.update.map((u) => u.id)).toEqual(['e1']);
    expect(changes.update[0]!.body.start?.dateTime).toBe('2026-10-13T13:00:00.000Z');
  });

  it('l’heure fixée, l’événement quitte la journée pour son créneau', () => {
    const changes = planCalendar([{ ...eloise, time: '14:00' }], [ours('e1', eloise)], 60, TODAY);
    expect(changes.update.map((u) => u.id)).toEqual(['e1']);
    expect(changes.update[0]!.body.start).toEqual({
      dateTime: '2026-10-14T12:00:00.000Z',
      timeZone: 'Europe/Paris',
    });
    // Et rien ne bouge tant qu'elle n'est pas fixée.
    expect(planCalendar([eloise], [ours('e1', eloise)], 60, TODAY).update).toEqual([]);
  });

  it('supprime ses événements qui ne sont plus voulus, jamais ceux écrits à la main', () => {
    const handwritten: CalendarEvent = {
      id: 'm1',
      summary: 'rdv enzo - pierre hugo',
      start: { dateTime: '2026-10-13T16:00:00+02:00' },
      end: { dateTime: '2026-10-13T17:00:00+02:00' },
    };
    const changes = planCalendar([], [ours('e1', vincent), handwritten], 60, TODAY);
    expect(changes.remove).toEqual(['e1']);
  });

  it('un rendez-vous déjà écrit à la main au même créneau l’emporte', () => {
    const handwritten: CalendarEvent = {
      id: 'm1',
      summary: 'rdv loys - vincent',
      start: { dateTime: '2026-10-13T14:00:00+02:00' },
      end: { dateTime: '2026-10-13T15:00:00+02:00' },
    };
    expect(planCalendar([vincent], [handwritten], 60, TODAY)).toEqual({
      create: [],
      update: [],
      remove: [],
    });
    // Écrit à la main après coup : celui du bot s'efface.
    expect(planCalendar([vincent], [handwritten, ours('e1', vincent)], 60, TODAY).remove).toEqual([
      'e1',
    ]);
    // Un autre créneau ou un autre nom : ce n'est pas le même rendez-vous.
    const other = { ...handwritten, start: { dateTime: '2026-10-13T16:00:00+02:00' } };
    expect(planCalendar([vincent], [other], 60, TODAY).create).toHaveLength(1);
  });

  it('sans heure : un rendez-vous écrit à la main le même jour l’emporte', () => {
    const handwritten: CalendarEvent = {
      id: 'm1',
      summary: 'rdv r2 - enzo - Éloïse Fiat',
      start: { dateTime: '2026-10-14T14:00:00+02:00' },
      end: { dateTime: '2026-10-14T15:00:00+02:00' },
    };
    expect(planCalendar([eloise], [handwritten], 60, TODAY).create).toEqual([]);
    const otherDay = { ...handwritten, start: { dateTime: '2026-10-15T14:00:00+02:00' } };
    expect(planCalendar([eloise], [otherDay], 60, TODAY).create).toHaveLength(1);
  });

  it('un doublon du bot est supprimé, le passé n’est pas touché', () => {
    const past = ours('old', { ...vincent, key: 'task:1', date: '2026-10-12' });
    const changes = planCalendar(
      [vincent],
      [ours('e1', vincent), ours('e2', vincent), past],
      60,
      TODAY,
    );
    expect(changes.remove).toEqual(['e2']);
  });
});
