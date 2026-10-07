import { describe, expect, it } from 'vitest';
import type { Lead } from './airtable';
import {
  actionKind,
  addDays,
  buildAgenda,
  compareTime,
  dueTime,
  leadName,
  padDate,
  parseEventDate,
  parseTime,
  resolveDueDate,
  signatureOf,
  taskDetails,
  taskLabel,
} from './planner';

const TODAY = '2026-10-07';

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

describe('parseEventDate', () => {
  it('lit une date jour/mois dans une phrase', () => {
    expect(parseEventDate('A appeler jeudi 08/10', TODAY)).toBe('2026-10-08');
    expect(parseEventDate('Lun. 12/10 à 10 h · R2', TODAY)).toBe('2026-10-12');
  });

  it('accepte le point comme séparateur et une année explicite', () => {
    expect(parseEventDate('rdv le 9.10', TODAY)).toBe('2026-10-09');
    expect(parseEventDate('le 03/01/2027 au cabinet', TODAY)).toBe('2027-01-03');
    expect(parseEventDate('le 03/01/27', TODAY)).toBe('2027-01-03');
  });

  it('choisit l’année la plus proche quand elle n’est pas écrite', () => {
    // En décembre, « 05/01 » désigne janvier prochain.
    expect(parseEventDate('relance 05/01', '2026-12-20')).toBe('2027-01-05');
    // En janvier, « 28/12 » désigne le mois dernier.
    expect(parseEventDate('appelé le 28/12', '2027-01-03')).toBe('2026-12-28');
  });

  it('comprend début, mi et fin de mois', () => {
    expect(parseEventDate('à relancer fin octobre car examen', TODAY)).toBe('2026-10-25');
    expect(parseEventDate('rappeler mi-novembre', TODAY)).toBe('2026-11-15');
    expect(parseEventDate('début décembre', TODAY)).toBe('2026-12-01');
  });

  it('ne lit pas de date dans un téléphone ni dans une heure', () => {
    expect(parseEventDate('06.31.22.71.81', TODAY)).toBeNull();
    expect(parseEventDate('01.02.03.04.05', TODAY)).toBeNull();
    expect(parseEventDate('entre 16h et 16h30', TODAY)).toBeNull();
    expect(parseEventDate('rappeler afin octobre', TODAY)).toBeNull();
  });

  it('ignore une date impossible et renvoie null sans texte', () => {
    expect(parseEventDate('le 31/02', TODAY)).toBeNull();
    expect(parseEventDate(null, TODAY)).toBeNull();
    expect(parseEventDate('jeudi', TODAY)).toBeNull();
  });
});

describe('resolveDueDate', () => {
  it('privilégie le champ date', () => {
    const l = lead({ dateAction: '2026-10-08', prochainEvenement: 'Lundi 12/10 à 11h' });
    expect(resolveDueDate(l, TODAY)).toEqual({ date: '2026-10-08', inferred: false });
  });

  it('se rabat sur le texte du prochain événement', () => {
    const l = lead({ prochainEvenement: 'A appeler jeudi 08/10' });
    expect(resolveDueDate(l, TODAY)).toEqual({ date: '2026-10-08', inferred: true });
  });

  it('renvoie null sans aucune date', () => {
    expect(resolveDueDate(lead({ action: 'Attente de doc' }), TODAY)).toBeNull();
  });
});

describe('libellés', () => {
  it('reconnaît chaque action Airtable', () => {
    expect(actionKind('a call')).toBe('call');
    expect(actionKind('R1')).toBe('r1');
    expect(actionKind('R2')).toBe('r2');
    expect(actionKind('A relancer ( une date )')).toBe('relance');
    expect(actionKind('Attente de doc')).toBe('doc');
    expect(actionKind('en cours')).toBe('en_cours');
    expect(actionKind('retour client')).toBe('retour');
    expect(actionKind('dead')).toBe('dead');
    expect(actionKind(null)).toBe('none');
    expect(actionKind('Devis envoyé')).toBe('other');
  });

  it('nomme le lead sans répéter le cabinet', () => {
    expect(leadName(lead({ nom: 'Paul', cabinet: 'Atelier Martin' }))).toBe(
      'Paul · Atelier Martin',
    );
    expect(leadName(lead({ nom: 'Atelier X', cabinet: 'atelier x' }))).toBe('Atelier X');
    expect(leadName(lead({ email: 'a@b.fr' }))).toBe('a@b.fr');
  });

  it('formule la tâche selon l’action', () => {
    const base = { nom: 'Paul', cabinet: 'Atelier Martin' };
    expect(taskLabel(lead({ ...base, action: 'a call' }))).toBe('Appeler Paul · Atelier Martin');
    expect(taskLabel(lead({ ...base, action: 'R2' }))).toBe('R2 avec Paul · Atelier Martin');
    expect(taskLabel(lead({ ...base, action: 'Devis envoyé' }))).toBe(
      'Devis envoyé : Paul · Atelier Martin',
    );
  });

  it('ne détaille que la consigne, le téléphone et un retard', () => {
    const l = lead({
      prochainEvenement: 'Rappel promis',
      telephone: '06 00 00 00 00',
      verdict: '🟢 Chaud',
    });
    expect(taskDetails(l, { date: '2026-10-05', inferred: true }, TODAY)).toBe(
      'Rappel promis · ☎ 06 00 00 00 00 · prévu le 05/10',
    );
    expect(taskDetails(lead({}), { date: TODAY, inferred: false }, TODAY)).toBe('');
  });

  it('change de signature quand l’action ou la date changent', () => {
    const l = lead({ action: 'a call' });
    const a = signatureOf(l, { date: '2026-10-08', inferred: false });
    expect(signatureOf(l, { date: '2026-10-09', inferred: false })).not.toBe(a);
    expect(signatureOf({ ...l, action: 'R1' }, { date: '2026-10-08', inferred: false })).not.toBe(
      a,
    );
  });
});

describe('heures', () => {
  it('lit la première heure d’un texte', () => {
    expect(parseTime('Jeudi 08/10 appel téléphonique à 11h')).toBe('11:00');
    expect(parseTime('Lun. 12/10 à 10 h · R2')).toBe('10:00');
    expect(parseTime('entre 16h30 et 17h')).toBe('16:30');
    expect(parseTime('rdv 9:05')).toBe('09:05');
    expect(parseTime('sous 24h')).toBeNull();
    expect(parseTime('06.31.22.71.81')).toBeNull();
    expect(parseTime(null)).toBeNull();
  });

  it('ne prend l’heure que si le texte parle du jour de l’action', () => {
    const due = { date: '2026-10-08', inferred: false };
    expect(dueTime(lead({ prochainEvenement: 'Jeudi 08/10 à 11h' }), due, TODAY)).toBe('11:00');
    expect(dueTime(lead({ prochainEvenement: 'Lundi 12/10 à 11h - doc' }), due, TODAY)).toBeNull();
    expect(dueTime(lead({ prochainEvenement: 'appel à 15h' }), due, TODAY)).toBe('15:00');
  });

  it('range les heures fixes d’abord', () => {
    expect(['10:00', null, '09:00'].sort(compareTime)).toEqual(['09:00', '10:00', null]);
  });
});

describe('buildAgenda', () => {
  const leads: Lead[] = [
    lead({
      id: 'recDUE',
      nom: 'Anne',
      action: 'Attente de doc',
      gestion: 'Enzo',
      dateAction: TODAY,
    }),
    lead({
      id: 'recLATE',
      nom: 'Bruno',
      action: 'a call',
      gestion: 'Enzo',
      dateAction: '2026-10-05',
      verdict: '⚪ Froid',
    }),
    lead({
      id: 'recHOT',
      nom: 'Carla',
      action: 'a call',
      gestion: 'Enzo',
      dateAction: '2026-10-05',
      verdict: '🟢 Chaud',
    }),
    lead({
      id: 'recTIME',
      nom: 'Jade',
      action: 'R1',
      gestion: 'Enzo',
      dateAction: TODAY,
      prochainEvenement: 'Mercredi 07/10 à 9h30',
    }),
    lead({
      id: 'recSOON',
      nom: 'Dina',
      action: 'R1',
      gestion: 'Enzo',
      dateAction: '2026-10-09',
      prochainEvenement: 'ven. 09/10 à 14h',
    }),
    lead({ id: 'recWEEK', nom: 'Elie', action: 'R2', gestion: 'Enzo', dateAction: '2026-10-13' }),
    lead({ id: 'recFAR', nom: 'Fred', action: 'R2', gestion: 'Enzo', dateAction: '2026-10-20' }),
    lead({
      id: 'recTXT',
      nom: 'Fanny',
      action: 'A relancer ( une date )',
      gestion: 'Loys',
      prochainEvenement: 'A appeler jeudi 08/10',
    }),
    lead({ id: 'recNODATE', nom: 'Gael', action: 'Attente de doc', gestion: 'Loys' }),
    lead({ id: 'recDEAD', nom: 'Hugo', action: 'dead', gestion: 'Loys', dateAction: TODAY }),
    lead({ id: 'recNOBODY', nom: 'Iris', action: 'a call', dateAction: TODAY }),
  ];
  const agenda = buildAgenda(leads, TODAY);

  it('range la journée : retards, puis heures fixes, puis leads chauds', () => {
    expect(agenda.people.Enzo.due.map((t) => t.recordId)).toEqual([
      'recHOT',
      'recLATE',
      'recTIME',
      'recDUE',
    ]);
    expect(agenda.people.Enzo.due[2]!.time).toBe('09:30');
  });

  it('met les 6 jours suivants dans la semaine, avec l’heure', () => {
    expect(agenda.people.Enzo.upcoming).toEqual([
      { date: '2026-10-09', time: '14:00', label: 'R1 avec Dina' },
      { date: '2026-10-13', time: null, label: 'R2 avec Elie' },
    ]);
    expect(agenda.people.Loys.upcoming).toEqual([
      { date: '2026-10-08', time: null, label: 'Relancer Fanny' },
    ]);
  });

  it('ignore les leads morts, sans date ou sans responsable', () => {
    expect(agenda.people.Loys.due).toEqual([]);
    const all = [...agenda.people.Loys.due, ...agenda.people.Enzo.due].map((t) => t.recordId);
    expect(all).not.toContain('recNOBODY');
  });

  it('une tâche du texte devient échue le jour venu', () => {
    const tomorrow = buildAgenda(leads, addDays(TODAY, 1));
    expect(tomorrow.people.Loys.due.map((t) => t.recordId)).toEqual(['recTXT']);
  });
});

describe('padDate', () => {
  it('complète les zéros', () => {
    expect(padDate('2026-8-5')).toBe('2026-08-05');
    expect(padDate('2026-10-07')).toBe('2026-10-07');
  });
});
