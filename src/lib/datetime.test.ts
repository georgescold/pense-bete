import { describe, expect, it } from 'vitest';
import {
  ESCALATION_LADDER_MS,
  buildDayOptions,
  buildHourOptions,
  buildMinuteOptions,
  buildPeriodOptions,
  currentPeriodValue,
  escalationDelayLabel,
  escalationDelayMs,
  parisDateValue,
  selectionToDate,
  zonedWallClockToUtc,
} from './datetime';

describe('zonedWallClockToUtc (Europe/Paris)', () => {
  it('convertit une heure murale été (CEST, +02:00)', () => {
    // 15 juillet 2026 14:30 Paris = 12:30 UTC
    const d = zonedWallClockToUtc({ year: 2026, month: 7, day: 15, hour: 14, minute: 30 });
    expect(d.toISOString()).toBe('2026-07-15T12:30:00.000Z');
  });

  it('convertit une heure murale hiver (CET, +01:00)', () => {
    // 15 janvier 2026 09:00 Paris = 08:00 UTC
    const d = zonedWallClockToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 });
    expect(d.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });
});

describe('selectionToDate', () => {
  it('reconstitue l’instant à partir des valeurs de la cascade', () => {
    const d = selectionToDate('2026-12-25', 10, 15);
    // 25 déc → hiver → +01:00
    expect(d.toISOString()).toBe('2026-12-25T09:15:00.000Z');
  });
});

describe('options des menus', () => {
  it('heures : 24 options', () => {
    expect(buildHourOptions()).toHaveLength(24);
  });

  it('minutes : pas de 5 (12 options)', () => {
    const m = buildMinuteOptions();
    expect(m).toHaveLength(12);
    expect(m.map((o) => o.value)).toContain('55');
  });
});

describe('sélecteur période / jour', () => {
  const now = new Date('2026-07-18T10:00:00Z'); // 18 juillet 2026 (2nde moitié)

  it('respecte la limite Discord de 25 options', () => {
    const periods = buildPeriodOptions(now);
    expect(periods.length).toBeLessThanOrEqual(25);
    expect(periods.length).toBeGreaterThan(0);
  });

  it('la 1re période contient aujourd’hui et démarre au bon endroit', () => {
    const periods = buildPeriodOptions(now);
    expect(periods[0]!.value).toBe('2026-7-2'); // juillet 2026, 2nde moitié
    expect(periods[0]!.label).toMatch(/juillet 2026/);
    expect(currentPeriodValue(now)).toBe('2026-7-2');
  });

  it('les jours passés du mois courant sont exclus', () => {
    const days = buildDayOptions('2026-7-2', now); // 16–31 juillet, mais on est le 18
    expect(days[0]!.value).toBe('2026-7-18');
    expect(days.every((d) => Number(d.value.split('-')[2]) >= 18)).toBe(true);
    expect(days.map((d) => d.value)).toContain('2026-7-31');
  });

  it('un jour choisi se reconvertit en instant correct', () => {
    const d = selectionToDate('2026-8-30', 14, 0); // 30 août → été (+02:00)
    expect(d.toISOString()).toBe('2026-08-30T12:00:00.000Z');
  });

  it('aucun menu jour ne dépasse 25 options', () => {
    for (const p of buildPeriodOptions(now)) {
      expect(buildDayOptions(p.value, now).length).toBeLessThanOrEqual(25);
    }
  });
});

describe('parisDateValue', () => {
  it('offset 0 = aujourd’hui, 1 = demain', () => {
    const now = new Date('2026-07-18T10:00:00Z');
    expect(parisDateValue(0, now)).toBe('2026-7-18');
    expect(parisDateValue(1, now)).toBe('2026-7-19');
  });
});

describe('échelle de relance', () => {
  it('suit 4h → 6h → 1j → 3j → 1sem', () => {
    expect(escalationDelayMs(0)).toBe(4 * 3_600_000);
    expect(escalationDelayMs(1)).toBe(6 * 3_600_000);
    expect(escalationDelayMs(2)).toBe(86_400_000);
    expect(escalationDelayMs(3)).toBe(3 * 86_400_000);
    expect(escalationDelayMs(4)).toBe(7 * 86_400_000);
  });

  it('répète la dernière valeur (1 semaine) au-delà', () => {
    expect(escalationDelayMs(5)).toBe(7 * 86_400_000);
    expect(escalationDelayMs(99)).toBe(ESCALATION_LADDER_MS[ESCALATION_LADDER_MS.length - 1]);
  });

  it('libellés cohérents', () => {
    expect(escalationDelayLabel(0)).toBe('4 h');
    expect(escalationDelayLabel(4)).toBe('1 semaine');
    expect(escalationDelayLabel(50)).toBe('1 semaine');
  });
});
