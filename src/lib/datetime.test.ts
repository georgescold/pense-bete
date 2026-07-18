import { describe, expect, it } from 'vitest';
import {
  ESCALATION_LADDER_MS,
  buildDateOptions,
  buildHourOptions,
  buildMinuteOptions,
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
  it('date : 25 options, la 1re = Aujourd’hui, la 2e = Demain', () => {
    const opts = buildDateOptions(new Date('2026-07-18T10:00:00Z'));
    expect(opts).toHaveLength(25);
    expect(opts[0]!.label).toMatch(/Aujourd'hui/);
    expect(opts[1]!.label).toMatch(/Demain/);
    expect(opts[0]!.value).toBe('2026-7-18');
  });

  it('heures : 24 options', () => {
    expect(buildHourOptions()).toHaveLength(24);
  });

  it('minutes : pas de 5 (12 options)', () => {
    const m = buildMinuteOptions();
    expect(m).toHaveLength(12);
    expect(m.map((o) => o.value)).toContain('55');
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
