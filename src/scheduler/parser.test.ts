import { describe, expect, it } from 'vitest';
import { parseFrenchSchedule } from './parser';

const NOW = new Date('2026-05-17T10:00:00Z'); // dimanche 17 mai 2026, 12:00 Paris

describe('parseFrenchSchedule — récurrents', () => {
  it('parse "tous les jours à 7h"', () => {
    const r = parseFrenchSchedule('tous les jours à 7h', NOW);
    expect(r.type).toBe('recurring');
    if (r.type === 'recurring') {
      expect(r.cron).toBe('0 7 * * *');
      expect(r.humanReadable).toContain('tous les jours');
    }
  });

  it('parse "tous les jours à 7h30"', () => {
    const r = parseFrenchSchedule('tous les jours à 7h30', NOW);
    if (r.type !== 'recurring') throw new Error('expected recurring');
    expect(r.cron).toBe('30 7 * * *');
    expect(r.humanReadable).toContain('07:30');
  });

  it('parse "tous les lundis à 8h"', () => {
    const r = parseFrenchSchedule('tous les lundis à 8h', NOW);
    if (r.type !== 'recurring') throw new Error('expected recurring');
    expect(r.cron).toBe('0 8 * * 1');
  });

  it('parse "tous les vendredis à 18h"', () => {
    const r = parseFrenchSchedule('tous les vendredis à 18h', NOW);
    if (r.type !== 'recurring') throw new Error('expected recurring');
    expect(r.cron).toBe('0 18 * * 5');
  });

  it('parse "tous les dimanches à 10h"', () => {
    const r = parseFrenchSchedule('tous les dimanches à 10h', NOW);
    if (r.type !== 'recurring') throw new Error('expected recurring');
    expect(r.cron).toBe('0 10 * * 0');
  });

  it('parse "tous les lundis et jeudis à 9h"', () => {
    const r = parseFrenchSchedule('tous les lundis et jeudis à 9h', NOW);
    if (r.type !== 'recurring') throw new Error('expected recurring');
    expect(r.cron).toBe('0 9 * * 1,4');
  });

  it('parse "tous les lundis et mercredis et vendredis à 9h"', () => {
    const r = parseFrenchSchedule('tous les lundis et mercredis et vendredis à 9h', NOW);
    if (r.type !== 'recurring') throw new Error('expected recurring');
    expect(r.cron).toBe('0 9 * * 1,3,5');
  });

  it('parse "tous les 15 du mois à 9h"', () => {
    const r = parseFrenchSchedule('tous les 15 du mois à 9h', NOW);
    if (r.type !== 'recurring') throw new Error('expected recurring');
    expect(r.cron).toBe('0 9 15 * *');
  });

  it('parse "tous les 1 du mois à 8h30"', () => {
    const r = parseFrenchSchedule('tous les 1 du mois à 8h30', NOW);
    if (r.type !== 'recurring') throw new Error('expected recurring');
    expect(r.cron).toBe('30 8 1 * *');
  });

  it('parse "le dernier jour du mois à 18h"', () => {
    const r = parseFrenchSchedule('le dernier jour du mois à 18h', NOW);
    if (r.type !== 'recurring') throw new Error('expected recurring');
    expect(r.cron).toBe('0 18 28-31 * *');
    expect(r.isLastDayOfMonth).toBe(true);
  });

  it('parse "toutes les 30 minutes"', () => {
    const r = parseFrenchSchedule('toutes les 30 minutes', NOW);
    if (r.type !== 'recurring') throw new Error('expected recurring');
    expect(r.cron).toBe('*/30 * * * *');
  });

  it('parse "toutes les 2 heures"', () => {
    const r = parseFrenchSchedule('toutes les 2 heures', NOW);
    if (r.type !== 'recurring') throw new Error('expected recurring');
    expect(r.cron).toBe('0 */2 * * *');
  });
});

describe('parseFrenchSchedule — ponctuels', () => {
  it('parse "dans 2h"', () => {
    const r = parseFrenchSchedule('dans 2h', NOW);
    if (r.type !== 'once') throw new Error('expected once');
    expect(r.runAt.getTime()).toBe(NOW.getTime() + 2 * 3_600_000);
  });

  it('parse "dans 30 minutes"', () => {
    const r = parseFrenchSchedule('dans 30 minutes', NOW);
    if (r.type !== 'once') throw new Error('expected once');
    expect(r.runAt.getTime()).toBe(NOW.getTime() + 30 * 60_000);
  });

  it('parse "dans 3 jours"', () => {
    const r = parseFrenchSchedule('dans 3 jours', NOW);
    if (r.type !== 'once') throw new Error('expected once');
    expect(r.runAt.getTime()).toBe(NOW.getTime() + 3 * 86_400_000);
  });

  it('parse "demain 9h" (via chrono)', () => {
    const r = parseFrenchSchedule('demain 9h', NOW);
    if (r.type !== 'once') throw new Error('expected once');
    expect(r.runAt.getTime()).toBeGreaterThan(NOW.getTime());
    // Demain à partir du dim 17 mai à 12h Paris = lundi 18 mai
    const diff = r.runAt.getTime() - NOW.getTime();
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThan(2 * 86_400_000);
  });
});

describe('parseFrenchSchedule — erreurs', () => {
  it('rejette une heure invalide (25h)', () => {
    expect(() => parseFrenchSchedule('tous les jours à 25h', NOW)).toThrow();
  });

  it('rejette une expression vide', () => {
    expect(() => parseFrenchSchedule('   ', NOW)).toThrow();
  });

  it('rejette une expression non comprise', () => {
    expect(() => parseFrenchSchedule('ksjdhfksjdhfksjdhf', NOW)).toThrow();
  });

  it('rejette un jour du mois invalide (32)', () => {
    expect(() => parseFrenchSchedule('tous les 32 du mois à 9h', NOW)).toThrow();
  });

  it('rejette un intervalle minutes > 59', () => {
    expect(() => parseFrenchSchedule('toutes les 90 minutes', NOW)).toThrow();
  });
});
