import type { ParsedSchedule } from '../scheduler/parser';

export interface Preset {
  key: string;
  label: string;
  build: (now: Date) => ParsedSchedule;
}

const minutes = (n: number) => n * 60_000;
const hours = (n: number) => n * 3_600_000;
const days = (n: number) => n * 86_400_000;

function once(label: string, deltaMs: number): (now: Date) => ParsedSchedule {
  return (now: Date) => ({
    type: 'once',
    runAt: new Date(now.getTime() + deltaMs),
    humanReadable: label,
  });
}

function recurring(
  label: string,
  cron: string,
  isLastDayOfMonth = false,
): (_now: Date) => ParsedSchedule {
  return () => ({
    type: 'recurring',
    cron,
    humanReadable: label,
    isLastDayOfMonth,
  });
}

export const PRESETS: Preset[] = [
  // --- Ponctuels ---
  { key: 'in_15min', label: 'Dans 15 minutes', build: once('Dans 15 minutes', minutes(15)) },
  { key: 'in_30min', label: 'Dans 30 minutes', build: once('Dans 30 minutes', minutes(30)) },
  { key: 'in_1h', label: 'Dans 1 heure', build: once('Dans 1 heure', hours(1)) },
  { key: 'in_2h', label: 'Dans 2 heures', build: once('Dans 2 heures', hours(2)) },
  { key: 'in_4h', label: 'Dans 4 heures', build: once('Dans 4 heures', hours(4)) },
  { key: 'in_8h', label: 'Dans 8 heures', build: once('Dans 8 heures', hours(8)) },
  { key: 'in_24h', label: 'Dans 24 heures', build: once('Dans 24 heures', hours(24)) },
  { key: 'in_2d', label: 'Dans 2 jours', build: once('Dans 2 jours', days(2)) },
  { key: 'in_1w', label: 'Dans 1 semaine', build: once('Dans 1 semaine', days(7)) },

  // --- Récurrents ---
  { key: 'r_daily_9h', label: '🔁 Tous les jours à 9h', build: recurring('tous les jours à 09:00 (Paris)', '0 9 * * *') },
  { key: 'r_daily_12h', label: '🔁 Tous les jours à 12h', build: recurring('tous les jours à 12:00 (Paris)', '0 12 * * *') },
  { key: 'r_daily_18h', label: '🔁 Tous les jours à 18h', build: recurring('tous les jours à 18:00 (Paris)', '0 18 * * *') },
  { key: 'r_daily_21h', label: '🔁 Tous les jours à 21h', build: recurring('tous les jours à 21:00 (Paris)', '0 21 * * *') },
  { key: 'r_monday_9h', label: '🔁 Tous les lundis à 9h', build: recurring('tous les lundis à 09:00 (Paris)', '0 9 * * 1') },
  { key: 'r_friday_17h', label: '🔁 Tous les vendredis à 17h', build: recurring('tous les vendredis à 17:00 (Paris)', '0 17 * * 5') },
  { key: 'r_weekday_9h', label: '🔁 Lun-Ven à 9h (jours ouvrés)', build: recurring('lundi à vendredi à 09:00 (Paris)', '0 9 * * 1-5') },
  { key: 'r_weekend_10h', label: '🔁 Sam-Dim à 10h (week-end)', build: recurring('samedi et dimanche à 10:00 (Paris)', '0 10 * * 6,0') },
  { key: 'r_month_1_9h', label: '🔁 Le 1er du mois à 9h', build: recurring('le 1er de chaque mois à 09:00 (Paris)', '0 9 1 * *') },
  { key: 'r_month_15_9h', label: '🔁 Le 15 du mois à 9h', build: recurring('le 15 de chaque mois à 09:00 (Paris)', '0 9 15 * *') },
  { key: 'r_last_day_18h', label: '🔁 Dernier jour du mois à 18h', build: recurring('le dernier jour du mois à 18:00 (Paris)', '0 18 28-31 * *', true) },
  { key: 'r_hourly', label: '🔁 Toutes les heures', build: recurring('toutes les heures', '0 * * * *') },
  { key: 'r_every_30min', label: '🔁 Toutes les 30 minutes', build: recurring('toutes les 30 minutes', '*/30 * * * *') },

  // --- Custom ---
  { key: 'custom', label: '📝 Personnalisé (texte libre)', build: () => { throw new Error('preset custom : utiliser le champ quand_personnalise'); } },
];

export const PRESET_BY_KEY = new Map(PRESETS.map((p) => [p.key, p]));

export interface ColorChoice {
  key: string;
  label: string;
  value: number;
}

export const COLORS: ColorChoice[] = [
  { key: 'bleu', label: '🔵 Bleu (défaut)', value: 0x5865f2 },
  { key: 'vert', label: '🟢 Vert', value: 0x57f287 },
  { key: 'jaune', label: '🟡 Jaune', value: 0xfee75c },
  { key: 'orange', label: '🟠 Orange', value: 0xe67e22 },
  { key: 'rouge', label: '🔴 Rouge', value: 0xed4245 },
  { key: 'violet', label: '🟣 Violet', value: 0x9b59b6 },
  { key: 'rose', label: '🩷 Rose', value: 0xeb459e },
  { key: 'noir', label: '⚫ Noir', value: 0x2c2f33 },
];

export const COLOR_BY_KEY = new Map(COLORS.map((c) => [c.key, c]));
export const DEFAULT_COLOR = COLORS[0]!.value;
