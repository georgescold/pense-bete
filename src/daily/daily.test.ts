import { describe, expect, it } from 'vitest';
import { previousPlanDate } from './service';
import { formatPlanDate } from './ui';

describe('previousPlanDate', () => {
  it('recule d’un jour au sein du même mois', () => {
    expect(previousPlanDate('2026-08-30')).toBe('2026-08-29');
  });

  it('passe au mois précédent', () => {
    expect(previousPlanDate('2026-09-01')).toBe('2026-08-31');
  });

  it('passe à l’année précédente', () => {
    expect(previousPlanDate('2026-01-01')).toBe('2025-12-31');
  });

  it('gère le 29 février d’une année bissextile', () => {
    expect(previousPlanDate('2028-03-01')).toBe('2028-02-29');
  });

  it('reste stable au passage à l’heure d’hiver (dernier dimanche d’octobre)', () => {
    // 25 octobre 2026 : la nuit où Paris repasse en UTC+1.
    expect(previousPlanDate('2026-10-26')).toBe('2026-10-25');
    expect(previousPlanDate('2026-10-25')).toBe('2026-10-24');
  });

  it('reste stable au passage à l’heure d’été (dernier dimanche de mars)', () => {
    expect(previousPlanDate('2026-03-30')).toBe('2026-03-29');
    expect(previousPlanDate('2026-03-29')).toBe('2026-03-28');
  });
});

describe('formatPlanDate', () => {
  it('rend une date française lisible', () => {
    expect(formatPlanDate('2026-08-30')).toBe('dimanche 30 août 2026');
  });

  it('ne décale pas le jour malgré le fuseau', () => {
    // Un bug classique : construire la date à minuit UTC la fait basculer au
    // jour précédent dans les fuseaux négatifs. On ancre donc à midi.
    expect(formatPlanDate('2026-01-01')).toBe('jeudi 1 janvier 2026');
    expect(formatPlanDate('2026-12-31')).toBe('jeudi 31 décembre 2026');
  });
});
