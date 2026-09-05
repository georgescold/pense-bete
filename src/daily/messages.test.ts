import { describe, expect, it } from 'vitest';
import { boardFooter, boardIntro, closingLine, prepIntro } from './messages';

describe('prepIntro', () => {
  it('insère la date', () => {
    expect(prepIntro('dimanche 30 août 2026')).toContain('dimanche 30 août 2026');
  });

  it('est déterministe', () => {
    const first = prepIntro('lundi');
    for (let i = 0; i < 20; i += 1) expect(prepIntro('lundi')).toBe(first);
  });
});

describe('boardIntro', () => {
  it('distingue repos, journée vide et journée remplie', () => {
    expect(boardIntro(0, true)).toBe('journée de repos.');
    expect(boardIntro(0)).toBe('aucune tâche enregistrée pour aujourd’hui.');
    expect(boardIntro(3)).toBe('tâches du jour.');
  });

  it('est déterministe', () => {
    const first = boardIntro(2);
    for (let i = 0; i < 20; i += 1) expect(boardIntro(2)).toBe(first);
  });
});

describe('closingLine', () => {
  it('énonce le compte sans le commenter', () => {
    expect(closingLine(3, 5)).toBe('Journée close. 3/5 tâche(s) cochée(s).');
    expect(closingLine(5, 5)).toBe('Journée close. 5/5 tâche(s) cochée(s).');
    expect(closingLine(0, 5)).toBe('Journée close. 0/5 tâche(s) cochée(s).');
  });

  it('gère la journée sans tâche', () => {
    expect(closingLine(0, 0)).toBe('Journée close. Aucune tâche enregistrée.');
  });

  it('signale le repos sans changer de registre', () => {
    expect(closingLine(0, 0, true)).toBe('Journée de repos close. Aucune tâche enregistrée.');
    expect(closingLine(2, 3, true)).toBe('Journée de repos close. 2/3 tâche(s) cochée(s).');
  });

  it('ne contient ni jugement ni familiarité, quel que soit le résultat', () => {
    const bannis = [
      'connard',
      'enculé',
      'merde',
      'feignasse',
      'déchet',
      'tocard',
      'bravo',
      'parfaite',
      'pathétique',
      'nul',
    ];
    const cas = [
      closingLine(0, 5),
      closingLine(1, 5),
      closingLine(4, 5),
      closingLine(5, 5),
      closingLine(0, 0),
      closingLine(0, 0, true),
      closingLine(1, 2, true),
    ];
    for (const ligne of cas) {
      expect(bannis.some((mot) => ligne.toLowerCase().includes(mot))).toBe(false);
    }
  });
});

describe('boardFooter', () => {
  it('dépend uniquement de l’état d’avancement', () => {
    expect(boardFooter(false)).toBe('Clique sur un numéro pour cocher');
    expect(boardFooter(true)).toBe('Toutes les tâches sont cochées');
    // Le seed est ignoré : le texte ne varie plus d'une journée à l'autre.
    expect(boardFooter(false, 1)).toBe(boardFooter(false, 99));
  });
});
