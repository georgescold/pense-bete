import { describe, expect, it } from 'vitest';
import { buildRecurrence } from './recurrence';

describe('buildRecurrence', () => {
  it('tous les jours', () => {
    const r = buildRecurrence({ freq: 'daily', days: [], monthDay: null, hour: 9, minute: 0 });
    expect(r).toMatchObject({ type: 'recurring', cron: '0 9 * * *' });
  });

  it('jours ouvrés', () => {
    const r = buildRecurrence({ freq: 'weekdays', days: [], monthDay: null, hour: 8, minute: 30 });
    expect(r).toMatchObject({ cron: '30 8 * * 1-5' });
  });

  it('week-end', () => {
    const r = buildRecurrence({ freq: 'weekend', days: [], monthDay: null, hour: 10, minute: 0 });
    expect(r).toMatchObject({ cron: '0 10 * * 6,0' });
  });

  it('hebdo : trie et dédoublonne les jours', () => {
    const r = buildRecurrence({ freq: 'weekly', days: [4, 1, 1], monthDay: null, hour: 14, minute: 15 });
    expect(r).toMatchObject({ cron: '15 14 * * 1,4' });
  });

  it('hebdo sans jour → erreur', () => {
    expect(() =>
      buildRecurrence({ freq: 'weekly', days: [], monthDay: null, hour: 9, minute: 0 }),
    ).toThrow();
  });

  it('mensuel', () => {
    const r = buildRecurrence({ freq: 'monthly', days: [], monthDay: 15, hour: 9, minute: 0 });
    expect(r).toMatchObject({ cron: '0 9 15 * *' });
  });

  it('mensuel sans jour → erreur', () => {
    expect(() =>
      buildRecurrence({ freq: 'monthly', days: [], monthDay: null, hour: 9, minute: 0 }),
    ).toThrow();
  });

  it('dernier jour du mois', () => {
    const r = buildRecurrence({ freq: 'lastday', days: [], monthDay: null, hour: 18, minute: 0 });
    expect(r).toMatchObject({ cron: '0 18 28-31 * *', isLastDayOfMonth: true });
  });
});
