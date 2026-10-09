import { describe, expect, it } from 'vitest';
import { pingPlan, untilText } from './planner';

const MIN = 60_000;
const start = Date.UTC(2026, 9, 13, 12, 0); // la tâche commence ici
const at = (minutesBefore: number) => start - minutesBefore * MIN;

describe('pings avant une tâche à heure fixe', () => {
  it('trois pings : 1 h, 30 min et 10 min avant', () => {
    expect(pingPlan(start, 0, at(120))).toEqual([
      { index: 0, delay: 60 * MIN },
      { index: 1, delay: 90 * MIN },
      { index: 2, delay: 110 * MIN },
    ]);
  });

  it('ne renvoie pas un ping déjà parti', () => {
    expect(pingPlan(start, 1, at(45))).toEqual([
      { index: 1, delay: 15 * MIN },
      { index: 2, delay: 35 * MIN },
    ]);
    expect(pingPlan(start, 3, at(5))).toEqual([]);
  });

  it('pings manqués (redémarrage, ajout tardif) : un seul part tout de suite', () => {
    // 15 min avant : le ping de 1 h et celui de 30 min sont passés.
    expect(pingPlan(start, 0, at(15))).toEqual([
      { index: 1, delay: 0 },
      { index: 2, delay: 5 * MIN },
    ]);
    // Ajoutée 4 min avant : un seul ping, immédiat.
    expect(pingPlan(start, 0, at(4))).toEqual([{ index: 2, delay: 0 }]);
  });

  it('rien une fois la tâche commencée', () => {
    expect(pingPlan(start, 0, start)).toEqual([]);
    expect(pingPlan(start, 0, start + 5 * MIN)).toEqual([]);
  });

  it('dit le temps qui reste', () => {
    expect(untilText(start, at(60))).toBe('dans 1 h');
    expect(untilText(start, at(65))).toBe('dans 1 h 05');
    expect(untilText(start, at(30))).toBe('dans 30 min');
    expect(untilText(start, at(10))).toBe('dans 10 min');
    expect(untilText(start, start)).toBe('maintenant');
  });
});
