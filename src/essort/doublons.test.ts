import { describe, expect, it } from 'vitest';
import type { Lead } from './airtable';
import { duplicatesCrm, leadTokens, type CrmMatch } from './planner';

const lead = (partial: Partial<Lead>): Lead =>
  ({ id: 'rec', email: null, nom: null, cabinet: null, ...partial }) as Lead;

const rdv = (names: string[], time: string | null) => ({
  time,
  match: { names, meeting: true, prep: false } as CrmMatch,
});

describe('doublons entre le CRM et le planning écrit à la main', () => {
  it('reconnaît un lead par son prénom, son nom ou son cabinet', () => {
    expect(leadTokens(lead({ nom: 'Hélène Hauviller', cabinet: 'Artephise Architecte' }))).toEqual([
      'helene',
      'hauviller',
      'artephise',
    ]);
    expect(leadTokens(lead({ nom: 'Léa', cabinet: 'Atelier d’Architecture Martin' }))).toEqual([
      'martin',
    ]);
  });

  it('même lead, même heure : un seul rendez-vous', () => {
    const crm = rdv(['helene', 'hauviller', 'artephise'], '10:30');
    const manual = {
      label: '10h30 rdv avec Hélène Hauviller - Rénovation écologique',
      time: '10:30',
    };
    expect(duplicatesCrm(manual, crm)).toBe(true);
    // L'heure écrite dans le texte suffit si le champ heure est vide.
    expect(duplicatesCrm({ ...manual, time: null }, crm)).toBe(true);
  });

  it('heure d’un seul côté : deux rendez-vous du même lead sont le même', () => {
    expect(
      duplicatesCrm({ label: 'Visio Éloïse Fiat', time: '14:00' }, rdv(['eloise', 'fiat'], null)),
    ).toBe(true);
  });

  it('deux actions différentes du même lead restent deux tâches', () => {
    const crm = rdv(['eloise', 'fiat'], null);
    expect(duplicatesCrm({ label: 'Envoyer doc R2 par mail à Eloise Fiat', time: null }, crm)).toBe(
      false,
    );
    // Deux heures différentes : deux moments distincts.
    expect(
      duplicatesCrm(
        { label: 'Visio Éloïse Fiat', time: '17:00' },
        rdv(['eloise', 'fiat'], '10:00'),
      ),
    ).toBe(false);
  });

  it('un autre lead n’est jamais un doublon', () => {
    expect(
      duplicatesCrm(
        { label: 'rdv avec Paul', time: '10:30' },
        rdv(['helene', 'hauviller'], '10:30'),
      ),
    ).toBe(false);
  });

  it('une préparation écrite à la main couvre celle du CRM', () => {
    const prep = { time: null, match: { names: ['chloe', 'pige'], meeting: false, prep: true } };
    expect(duplicatesCrm({ label: 'Préparer le doc pour Chloé', time: null }, prep)).toBe(true);
    expect(duplicatesCrm({ label: 'Appeler Chloé', time: null }, prep)).toBe(false);
  });

  it('une ancienne donnée sans de quoi comparer n’est jamais un doublon', () => {
    expect(duplicatesCrm({ label: 'rdv Hélène', time: '10:30' }, { time: '10:30' })).toBe(false);
  });
});
