import { describe, expect, it } from 'vitest';
import { hasFiredToday } from './jobs';

// Europe/Paris est à UTC+2 en août, UTC+1 en janvier.
const at = (iso: string) => new Date(iso);

describe('hasFiredToday', () => {
  const BOARD = '0 7 * * *';
  const PREP = '0 18 * * *';

  it('reconnaît le rendez-vous de 7h déjà passé', () => {
    // 08:00 à Paris : celui de 7h est passé aujourd'hui.
    expect(hasFiredToday(BOARD, at('2026-08-29T06:00:00Z'))).toBe(true);
  });

  it('ne rattrape pas un rendez-vous de 7h encore à venir', () => {
    // 06:00 à Paris : la dernière occurrence est celle d'hier.
    expect(hasFiredToday(BOARD, at('2026-08-29T04:00:00Z'))).toBe(false);
  });

  it('reconnaît le rendez-vous de 18h déjà passé', () => {
    // 19:00 à Paris.
    expect(hasFiredToday(PREP, at('2026-08-29T17:00:00Z'))).toBe(true);
  });

  it('ne rattrape pas 18h en pleine matinée', () => {
    // 09:00 à Paris : le dernier 18h remonte à hier.
    expect(hasFiredToday(PREP, at('2026-08-29T07:00:00Z'))).toBe(false);
  });

  it('tient compte du décalage hivernal', () => {
    // 15 janvier, Paris à UTC+1 : 07:30 locales.
    expect(hasFiredToday(BOARD, at('2026-01-15T06:30:00Z'))).toBe(true);
    // 06:30 locales, le rendez-vous n'est pas encore passé.
    expect(hasFiredToday(BOARD, at('2026-01-15T05:30:00Z'))).toBe(false);
  });

  it('ne jette pas sur une expression illisible', () => {
    expect(hasFiredToday('pas un cron', at('2026-08-29T06:00:00Z'))).toBe(false);
  });
});
