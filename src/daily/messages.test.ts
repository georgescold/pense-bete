import { describe, expect, it } from 'vitest';
import { boardFooter, boardIntro, closingLine, prepIntro } from './messages';

describe('prepIntro', () => {
  it('insère toujours la date, quelle que soit la variante tirée', () => {
    for (let i = 0; i < 60; i += 1) {
      const line = prepIntro('dimanche 30 août 2026');
      expect(line).toContain('dimanche 30 août 2026');
      expect(line).not.toContain('{date}');
    }
  });

  it('ne renvoie pas toujours la même phrase', () => {
    const seen = new Set(Array.from({ length: 60 }, () => prepIntro('lundi')));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('boardIntro', () => {
  it('distingue une journée vide d’une journée remplie', () => {
    const empty = Array.from({ length: 40 }, () => boardIntro(0));
    const filled = Array.from({ length: 40 }, () => boardIntro(3));
    // Les deux lots ne doivent jamais se chevaucher.
    expect(empty.some((e) => filled.includes(e))).toBe(false);
  });
});

describe('closingLine', () => {
  it('substitue les compteurs', () => {
    for (let i = 0; i < 40; i += 1) {
      const line = closingLine(3, 5);
      expect(line).not.toContain('{done}');
      expect(line).not.toContain('{total}');
      expect(line).toContain('5');
    }
  });

  it('félicite une journée complète', () => {
    const lines = Array.from({ length: 40 }, () => closingLine(4, 4));
    expect(lines.every((l) => l.includes('4/4'))).toBe(true);
  });

  it('ne félicite pas une journée à zéro', () => {
    const lines = Array.from({ length: 40 }, () => closingLine(0, 6));
    expect(lines.every((l) => !l.includes('parfaite') && !l.includes('Carton'))).toBe(true);
  });

  it('substitue toutes les occurrences, même répétées dans une phrase', () => {
    for (let i = 0; i < 80; i += 1) {
      expect(closingLine(0, 7)).not.toContain('{total}');
      expect(closingLine(2, 7)).not.toContain('{total}');
    }
  });

  it('gère une journée sans aucune tâche', () => {
    const line = closingLine(0, 0);
    expect(line).not.toContain('0/0');
    expect(line.length).toBeGreaterThan(0);
  });
});

describe('boardFooter', () => {
  it('reste stable pour une même journée', () => {
    const first = boardFooter(false, 42);
    for (let i = 0; i < 20; i += 1) expect(boardFooter(false, 42)).toBe(first);
  });

  it('change de texte selon la journée', () => {
    const seen = new Set(Array.from({ length: 12 }, (_, i) => boardFooter(false, i)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('journée de repos', () => {
  it('ne reproche jamais rien un jour de repos', () => {
    const lines = Array.from({ length: 60 }, () => closingLine(0, 0, true));
    const insultes = ['connard', 'enculé', 'merde', 'feignasse', 'déchet', 'tocard'];
    expect(lines.every((l) => !insultes.some((i) => l.toLowerCase().includes(i)))).toBe(true);
  });

  it('salue les tâches faites malgré le repos', () => {
    for (let i = 0; i < 40; i += 1) {
      const line = closingLine(2, 3, true);
      expect(line).toContain('2/3');
      expect(line).not.toContain('{done}');
    }
  });

  it('propose une intro dédiée au repos', () => {
    const rest = Array.from({ length: 40 }, () => boardIntro(0, true));
    const work = Array.from({ length: 40 }, () => boardIntro(0, false));
    expect(rest.some((r) => work.includes(r))).toBe(false);
  });
});
