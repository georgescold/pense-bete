import { describe, expect, it } from 'vitest';
import {
  buildCrmAgenda,
  defaultTitle,
  peopleFor,
  recordUrl,
  signatureOf,
  type CrmData,
  type CrmLeadAction,
  type CrmTache,
} from './crm';

const today = '2026-10-28';

const action = (partial: Partial<CrmLeadAction>): CrmLeadAction => ({
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
  ...partial,
});

const tache = (partial: Partial<CrmTache>): CrmTache => ({
  id: 't-video',
  titre: 'Tourner la vidéo coachs',
  note: null,
  jour: today,
  heure: '10:00',
  duree_minutes: 90,
  responsable: 'Loys',
  lead_id: null,
  lead_nom: null,
  lead_cabinet: null,
  lead_telephone: null,
  ...partial,
});

const agenda = (data: Partial<CrmData>) =>
  buildCrmAgenda({ actions: [], taches: [], ...data }, today);

describe('lecture du CRM', () => {
  it('pose la prochaine action sur le tableau de son responsable, à son heure', () => {
    const { people } = agenda({ actions: [action({})] });
    expect(people.Enzo.due).toEqual([
      expect.objectContaining({
        recordId: 'lead:f-lucie',
        label: 'R1 · Enzo appelle Lucie',
        time: '17:00',
        dueDate: today,
      }),
    ]);
    expect(people.Enzo.due[0]!.match).toEqual({ names: ['lucie'], meeting: true, prep: false });
    expect(people.Loys.due).toEqual([]);
  });

  it('nomme le lead quand le libellé ne le dit pas, avec le cabinet et le téléphone pour un appel', () => {
    const { people } = agenda({
      actions: [
        action({
          id: 'f-camille',
          nom: 'Camille Dubreuil',
          cabinet: 'Atelier Ardoise',
          telephone: '+33 6 12 34 56 78',
          libelle: 'Appel',
          statut: 'attente_reponse',
        }),
      ],
    });
    expect(people.Enzo.due[0]).toMatchObject({
      label: 'Appel · Camille Dubreuil',
      details: 'Atelier Ardoise · ☎ +33 6 12 34 56 78',
    });
  });

  it('ne répète pas un numéro déjà écrit dans le libellé', () => {
    const { people } = agenda({
      actions: [
        action({
          nom: 'Théo K.',
          telephone: '+33600000042',
          libelle: 'R1 · Enzo appelle Théo au 06 00 00 00 42',
        }),
      ],
    });
    expect(people.Enzo.due[0]!.details).toBe('');
  });

  it('sans libellé, le titre vient de l’étape, comme dans le calendrier du CRM', () => {
    expect(defaultTitle('r2')).toBe('R2');
    expect(defaultTitle('a_relancer')).toBe('Relance');
    const { people } = agenda({
      actions: [action({ nom: 'Jean-Marc Bernier', libelle: null, statut: 'attente_reponse' })],
    });
    expect(people.Enzo.due[0]!.label).toBe('Relance · Jean-Marc Bernier');
  });

  it('range retard, jour, semaine et au-delà', () => {
    const { people } = agenda({
      actions: [
        action({ id: 'retard', nom: 'Sophie Garnier', libelle: 'Appel', jour: '2026-10-16' }),
        action({
          id: 'semaine',
          nom: 'Inès',
          libelle: 'R1',
          jour: '2026-10-29',
          heure: '14:00',
        }),
        action({ id: 'loin', nom: 'Antoine', libelle: 'R1', jour: '2026-11-06', heure: '11:00' }),
      ],
    });
    // En retard : sur le jour, sans heure (elle sonnerait pour rien), l'heure prévue dans le détail.
    expect(people.Enzo.due).toEqual([
      expect.objectContaining({
        recordId: 'lead:retard',
        time: null,
        details: 'en retard, prévu le 16/10 à 17:00',
      }),
    ]);
    expect(people.Enzo.upcoming.map((u) => u.key)).toEqual([
      `lead:semaine|${signatureOf('R1', '2026-10-29')}`,
    ]);
    // Tout reste dans `actions` : une tâche déplacée sur un jour lointain n'est pas effacée.
    expect(people.Enzo.actions.map((a) => a.date)).toEqual([
      '2026-10-16',
      '2026-10-29',
      '2026-11-06',
    ]);
  });

  it('une heure à minuit (null) est un jour sans heure', () => {
    const { people } = agenda({ actions: [action({ heure: null })] });
    expect(people.Enzo.due[0]!.time).toBeNull();
  });

  it('une tâche du calendrier va chez son responsable, avec sa durée pour l’agenda', () => {
    const { people } = agenda({ taches: [tache({})] });
    expect(people.Loys.due).toEqual([
      expect.objectContaining({ recordId: 'tache:t-video', label: 'Tourner la vidéo coachs' }),
    ]);
    expect(people.Loys.actions[0]!.minutes).toBe(90);
    expect(people.Enzo.due).toEqual([]);
  });

  it('une tâche rattachée à un lead le nomme, et garde sa note', () => {
    const { people } = agenda({
      taches: [
        tache({
          titre: 'Rappeler',
          note: 'Il attend la brochure',
          lead_id: 'f-julie',
          lead_nom: 'Julie Perrin',
          lead_telephone: '06 11 22 33 44',
        }),
      ],
    });
    expect(people.Loys.due[0]).toMatchObject({
      label: 'Rappeler · Julie Perrin',
      details: 'Il attend la brochure · ☎ 06 11 22 33 44',
    });
  });

  it('sans responsable : les deux tableaux, chacun sa ligne', () => {
    const { people } = agenda({ taches: [tache({ responsable: null })] });
    expect(people.Loys.due[0]!.recordId).toBe('tache:t-video@loys');
    expect(people.Enzo.due[0]!.recordId).toBe('tache:t-video@enzo');
  });

  it('sans responsable, le prénom de l’équipe cité dans le texte ; un autre prénom : aucun tableau', () => {
    expect(peopleFor(null, 'R1 · Enzo appelle Lucie')).toEqual(['Enzo']);
    expect(peopleFor(null, 'Loys et Enzo font le point')).toEqual(['Loys', 'Enzo']);
    expect(peopleFor('loys', '')).toEqual(['Loys']);
    expect(peopleFor('Valentin', 'Enzo')).toEqual([]);
  });

  it('les leads chauds d’abord à heure égale', () => {
    const { people } = agenda({
      actions: [
        action({ id: 'froid', nom: 'Paul', libelle: 'Appel', verdict: 'froid' }),
        action({ id: 'chaud', nom: 'Anne', libelle: 'Appel', verdict: 'chaud' }),
      ],
    });
    expect(people.Enzo.due.map((d) => d.recordId)).toEqual(['lead:chaud', 'lead:froid']);
  });

  it('garde des clés courtes : elles servent de valeur dans les menus Discord (100 caractères)', () => {
    const long =
      'R1 · Enzo appelle Lucie (son numéro à lui demander sur Instagram à 16 h 50) '.repeat(3);
    const { people } = agenda({
      actions: [
        action({ id: '00000000-0000-4000-8000-000000000001', libelle: long, jour: '2026-10-30' }),
      ],
      taches: [
        tache({
          id: '00000000-0000-4000-8000-000000000002',
          // Sans prénom de l'équipe ni responsable : sur les deux tableaux, clé la plus longue.
          titre: 'Préparer la proposition détaillée du cabinet avant le rendez-vous '.repeat(3),
          responsable: null,
          jour: '2026-10-30',
        }),
      ],
    });
    const keys = [...people.Loys.upcoming, ...people.Enzo.upcoming].map((u) => `crm:${u.key}`);
    expect(keys).toHaveLength(3);
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(100);
    // Même libellé (aux accents et espaces près), même date : même signature.
    expect(signatureOf('Rappeler  Élodie', '2026-10-30')).toBe(
      signatureOf('rappeler elodie', '2026-10-30'),
    );
  });

  it('mène à la fiche ou à la tâche dans le CRM', () => {
    expect(recordUrl('lead:abc')).toBe('https://crm.essort.agency/leads/abc');
    expect(recordUrl('tache:t1@enzo')).toBe('https://crm.essort.agency/calendrier?tache=t1');
    expect(recordUrl('recXYZ')).toBe('');
  });
});
