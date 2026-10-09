import { describe, expect, it } from 'vitest';
import type { Lead } from './airtable';
import {
  actionKind,
  addDays,
  buildAgenda,
  compareTime,
  dueTime,
  eventNote,
  leadName,
  leadSteps,
  padDate,
  parseEventDate,
  parseTime,
  personOf,
  previousBusinessDay,
  resolveDueDate,
  signatureOf,
  taskDetails,
  taskLabel,
  textDates,
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
      action: 'a call',
      prochainEvenement: 'Rappel promis',
      telephone: '06 00 00 00 00',
      verdict: '🟢 Chaud',
    });
    const step = leadSteps({ ...l, dateAction: '2026-10-05' }, TODAY)[0]!;
    expect(taskDetails(l, step, TODAY)).toBe(
      'Rappel promis · ☎ 06 00 00 00 00 · en retard, prévu le 05/10',
    );
    const empty = lead({ dateAction: TODAY });
    expect(taskDetails(empty, leadSteps(empty, TODAY)[0]!, TODAY)).toBe('');
  });

  it('ne donne le téléphone que s’il faut appeler', () => {
    const base = { telephone: '06 00', dateAction: TODAY };
    const doc = lead({ ...base, action: 'Attente de doc', prochainEvenement: 'Doc à envoyer' });
    expect(taskDetails(doc, leadSteps(doc, TODAY)[0]!, TODAY)).toBe('Doc à envoyer');
    const r1 = lead({ ...base, action: 'R1', prochainEvenement: 'appel téléphonique' });
    expect(taskDetails(r1, leadSteps(r1, TODAY)[0]!, TODAY)).toBe('Appel téléphonique · ☎ 06 00');
    const prep = lead({ ...base, action: 'a call', prochainEvenement: 'Lundi 12/10 à 11h' });
    expect(taskDetails(prep, leadSteps(prep, TODAY)[0]!, TODAY)).toBe('Lundi 12/10 à 11h');
  });

  it('retire de la consigne le jour et l’heure déjà affichés', () => {
    const t = 'Jeudi 08/10 appel téléphonique à 11h (sauf si message insta reçu)';
    expect(eventNote(t, '2026-10-08', '11:00', TODAY)).toBe(
      'Appel téléphonique (sauf si message insta reçu)',
    );
    expect(eventNote('Lundi 12/10 à 11h - doc à préparer', '2026-10-08', null, TODAY)).toBe(
      'Lundi 12/10 à 11h - doc à préparer',
    );
    expect(eventNote('Lundi 12/10 entre 16h et 16h30', '2026-10-12', '16:00', TODAY)).toBe(
      'Entre 16h et 16h30',
    );
    expect(eventNote('Vendredi 09/10 à 14h', '2026-10-09', '14:00', TODAY)).toBeNull();
  });

  it('change de signature quand l’action ou la date changent', () => {
    const l = lead({ action: 'a call' });
    const a = signatureOf(l, '2026-10-08');
    expect(signatureOf(l, '2026-10-09')).not.toBe(a);
    expect(signatureOf({ ...l, action: 'R1' }, '2026-10-08')).not.toBe(a);
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

describe('leadSteps', () => {
  const day = '2026-10-08';

  it('sépare la préparation du rendez-vous quand le texte donne une date plus tardive', () => {
    const l = lead({
      nom: 'Isabelle',
      action: 'R2',
      dateAction: day,
      prochainEvenement: 'Lundi 12/10 à 11h - doc à préparer',
    });
    expect(leadSteps(l, day)).toEqual([
      {
        date: day,
        time: null,
        label: 'Préparer le R2 avec Isabelle',
        signature: 'r2|2026-10-08',
        prep: true,
        kind: 'r2',
        note: 'Lundi 12/10 à 11h - doc à préparer',
      },
      {
        date: '2026-10-12',
        time: '11:00',
        label: 'R2 avec Isabelle',
        signature: 'r2|2026-10-12',
        prep: false,
        kind: 'r2',
        note: 'Doc à préparer',
      },
    ]);
  });

  it('place le rendez-vous au jour du texte, même si le champ date est la veille', () => {
    const l = lead({
      nom: 'Pierre-Hugo',
      action: 'R2',
      dateAction: '2026-10-11',
      prochainEvenement: 'Lundi 12/10 entre 16h et 16h30',
    });
    const steps = leadSteps(l, day);
    expect(steps.map((s) => [s.date, s.time, s.label])).toEqual([
      ['2026-10-11', null, 'Préparer le R2 avec Pierre-Hugo'],
      ['2026-10-12', '16:00', 'R2 avec Pierre-Hugo'],
    ]);
  });

  it('une seule étape quand les dates concordent, ou hors rendez-vous', () => {
    const same = lead({
      action: 'a call',
      dateAction: day,
      prochainEvenement: 'Jeudi 08/10 à 11h',
    });
    expect(leadSteps(same, day)).toHaveLength(1);
    expect(leadSteps(same, day)[0]!.time).toBe('11:00');
    const doc = lead({
      action: 'Attente de doc',
      dateAction: '2026-10-07',
      prochainEvenement: 'Doc à envoyer pour vendredi 09/10 ?',
    });
    expect(leadSteps(doc, day).map((s) => s.date)).toEqual(['2026-10-07']);
  });

  it('un rendez-vous passé ne laisse que lui-même', () => {
    const l = lead({
      action: 'R1',
      dateAction: '2026-10-01',
      prochainEvenement: 'lun. 05/10 à 10h',
    });
    expect(leadSteps(l, day)).toEqual([
      {
        date: '2026-10-01',
        time: null,
        label: 'R1 avec Lead sans nom',
        signature: 'r1|2026-10-01',
        prep: false,
        kind: 'r1',
        note: 'Lun. 05/10 à 10h',
      },
    ]);
  });
});

describe('lecture fine du CRM', () => {
  const today = '2026-10-09'; // un vendredi

  it('texte à plusieurs dates : seule la partie de la date de l’action compte', () => {
    const l = lead({
      nom: 'Cynthia',
      action: 'Attente de doc',
      dateAction: '2026-10-13',
      telephone: '06 00',
      prochainEvenement:
        'Doc envoyé vendredi 09/10 - en attente de sa réponse, proposition d’appel téléphonique pour mardi 13/10 matin',
    });
    const [step, ...rest] = leadSteps(l, today);
    expect(rest).toEqual([]);
    expect(step).toMatchObject({ date: '2026-10-13', kind: 'call', label: 'Appeler Cynthia' });
    expect(step!.note).toBe('Proposition d’appel téléphonique matin');
    expect(taskDetails(l, step!, today)).toBe('Proposition d’appel téléphonique matin · ☎ 06 00');
  });

  it('ignore un texte qui raconte un événement passé, antérieur à l’action', () => {
    const l = lead({
      nom: 'Éloïse',
      action: 'R2',
      dateAction: '2026-10-14',
      prochainEvenement: 'Vendredi 09/10 à 14h appel téléphonique',
    });
    // Lu le lendemain de l'appel : le texte est périmé.
    expect(leadSteps(l, '2026-10-10')).toEqual([
      {
        date: '2026-10-14',
        time: null,
        label: 'R2 avec Éloïse',
        signature: 'r2|2026-10-14',
        prep: false,
        kind: 'r2',
        note: null,
      },
    ]);
    // Le jour même, l'appel est peut-être encore à venir : on le garde.
    expect(leadSteps(l, today)[0]!.note).toBe('Vendredi 09/10 à 14h appel téléphonique');
  });

  it('« doc à préparer » le jour du rendez-vous : préparation le jour ouvré d’avant', () => {
    const mardi = lead({
      nom: 'Vincent',
      action: 'R2',
      dateAction: '2026-10-13',
      prochainEvenement: 'Mar. 13/10 à 14 h · R2 · document à préparer, avec le cas client Homère',
    });
    expect(leadSteps(mardi, today).map((s) => [s.date, s.time, s.label, s.prep])).toEqual([
      ['2026-10-12', null, 'Préparer le R2 avec Vincent', true],
      ['2026-10-13', '14:00', 'R2 avec Vincent', false],
    ]);
    const lundi = lead({
      nom: 'Chloé',
      action: 'R2',
      dateAction: '2026-10-12',
      prochainEvenement: 'Lun. 12/10 à 10 h · R2 · doc à préparer',
    });
    expect(leadSteps(lundi, today).map((s) => [s.date, s.label])).toEqual([
      ['2026-10-09', 'Préparer le R2 avec Chloé'],
      ['2026-10-12', 'R2 avec Chloé'],
    ]);
    // Rendez-vous passé : pas de préparation après coup.
    const passe = {
      ...lundi,
      dateAction: '2026-10-05',
      prochainEvenement: 'Lun. 05/10 à 10 h · R2 · doc à préparer',
    };
    expect(leadSteps(passe, today)).toHaveLength(1);
  });

  it('une action « à relancer » que le texte décrit comme un appel devient un appel', () => {
    const l = lead({
      nom: 'Corinne',
      action: 'A relancer ( une date )',
      prochainEvenement: 'En attente de sa réponse au mail sinon à rappeler mardi 13/10',
    });
    const [step] = leadSteps(l, today);
    expect(step).toMatchObject({ date: '2026-10-13', kind: 'call', label: 'Appeler Corinne' });
    expect(step!.note).toBe('En attente de sa réponse au mail sinon à rappeler');
    // Sans verbe d'action dans le texte, la colonne « Action » reste maîtresse.
    const r = lead({ action: 'A relancer ( une date )', prochainEvenement: 'fin octobre, examen' });
    expect(leadSteps(r, today)[0]!.kind).toBe('relance');
    // Un rendez-vous n'est jamais renommé par le texte.
    const rdv = lead({ action: 'R1', dateAction: '2026-10-12', prochainEvenement: 'appel' });
    expect(leadSteps(rdv, today)[0]!.kind).toBe('r1');
  });

  it('date déduite du texte : la première à venir', () => {
    const l = lead({ prochainEvenement: 'Mail envoyé le 05/10, rappeler le 13/10 ou le 15/10' });
    expect(resolveDueDate(l, today)).toEqual({ date: '2026-10-13', inferred: true });
    expect(textDates(l.prochainEvenement, today)).toEqual([
      '2026-10-05',
      '2026-10-13',
      '2026-10-15',
    ]);
  });

  it('la bonne personne : Gestion, sinon le seul prénom de l’équipe cité', () => {
    expect(personOf(lead({ gestion: 'Loys', prochainEvenement: 'Enzo appelle' }))).toBe('Loys');
    expect(personOf(lead({ prochainEvenement: 'Lun. 12/10 · Enzo appelle Hélène' }))).toBe('Enzo');
    expect(personOf(lead({ prochainEvenement: 'Loys et Enzo en visio' }))).toBeNull();
    expect(personOf(lead({}))).toBeNull();
  });

  it('jour ouvré précédent', () => {
    expect(previousBusinessDay('2026-10-12')).toBe('2026-10-09'); // lundi → vendredi
    expect(previousBusinessDay('2026-10-11')).toBe('2026-10-09'); // dimanche → vendredi
    expect(previousBusinessDay('2026-10-14')).toBe('2026-10-13');
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
    const simple = (items: { date: string; time: string | null; label: string }[]) =>
      items.map(({ date, time, label }) => ({ date, time, label }));
    expect(simple(agenda.people.Enzo.upcoming)).toEqual([
      { date: '2026-10-09', time: '14:00', label: 'R1 avec Dina' },
      { date: '2026-10-13', time: null, label: 'R2 avec Elie' },
    ]);
    expect(simple(agenda.people.Loys.upcoming)).toEqual([
      { date: '2026-10-08', time: null, label: 'Appeler Fanny' },
    ]);
    // Chaque action garde de quoi la reconnaître dans le planning écrit à la main.
    expect(agenda.people.Enzo.upcoming[0]!.match).toEqual({
      names: ['dina'],
      meeting: true,
      prep: false,
    });
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
