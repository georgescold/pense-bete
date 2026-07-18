import type { ParsedSchedule } from '../scheduler/parser';

export type RecFreq =
  | 'daily'
  | 'weekly'
  | 'weekdays'
  | 'weekend'
  | 'monthly'
  | 'lastday';

export interface RecFreqOption {
  key: RecFreq;
  label: string;
  needsDays?: boolean; // weekly → choisir les jours
  needsMonthDay?: boolean; // monthly → choisir le jour du mois
}

export const REC_FREQS: RecFreqOption[] = [
  { key: 'daily', label: '📆 Tous les jours' },
  { key: 'weekly', label: '🗓️ Chaque semaine (jours choisis)', needsDays: true },
  { key: 'weekdays', label: '💼 Jours ouvrés (lun–ven)' },
  { key: 'weekend', label: '🌴 Week-end (sam–dim)' },
  { key: 'monthly', label: '📅 Chaque mois (jour choisi)', needsMonthDay: true },
  { key: 'lastday', label: '🔚 Dernier jour du mois' },
];

export const REC_FREQ_BY_KEY = new Map(REC_FREQS.map((f) => [f.key, f]));

// 0 = dimanche (convention cron).
export const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: 'Lundi' },
  { value: 2, label: 'Mardi' },
  { value: 3, label: 'Mercredi' },
  { value: 4, label: 'Jeudi' },
  { value: 5, label: 'Vendredi' },
  { value: 6, label: 'Samedi' },
  { value: 0, label: 'Dimanche' },
];

const DAY_LABEL: Record<number, string> = {
  0: 'dimanche',
  1: 'lundi',
  2: 'mardi',
  3: 'mercredi',
  4: 'jeudi',
  5: 'vendredi',
  6: 'samedi',
};

/** Jours du mois proposés (1–25, limite Discord 25 options). Au-delà : « Dernier jour du mois ». */
export const MONTH_DAYS = Array.from({ length: 25 }, (_, i) => i + 1);

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

export interface RecInput {
  freq: RecFreq;
  days: number[]; // pour weekly
  monthDay: number | null; // pour monthly
  hour: number;
  minute: number;
}

/** Construit un ParsedSchedule récurrent guidé (aucune saisie libre). */
export function buildRecurrence(input: RecInput): ParsedSchedule {
  const { freq, days, monthDay, hour, minute } = input;
  const time = `${pad2(hour)}:${pad2(minute)}`;
  const at = `à ${time} (heure de Paris)`;

  switch (freq) {
    case 'daily':
      return {
        type: 'recurring',
        cron: `${minute} ${hour} * * *`,
        humanReadable: `tous les jours ${at}`,
      };
    case 'weekdays':
      return {
        type: 'recurring',
        cron: `${minute} ${hour} * * 1-5`,
        humanReadable: `du lundi au vendredi ${at}`,
      };
    case 'weekend':
      return {
        type: 'recurring',
        cron: `${minute} ${hour} * * 6,0`,
        humanReadable: `le week-end (samedi et dimanche) ${at}`,
      };
    case 'weekly': {
      const sorted = Array.from(new Set(days)).sort((a, b) => a - b);
      if (sorted.length === 0) throw new Error('Choisis au moins un jour de la semaine.');
      const labels = sorted.map((d) => DAY_LABEL[d]).join(', ');
      return {
        type: 'recurring',
        cron: `${minute} ${hour} * * ${sorted.join(',')}`,
        humanReadable: `chaque semaine le ${labels} ${at}`,
      };
    }
    case 'monthly': {
      if (!monthDay) throw new Error('Choisis le jour du mois.');
      return {
        type: 'recurring',
        cron: `${minute} ${hour} ${monthDay} * *`,
        humanReadable: `le ${monthDay} de chaque mois ${at}`,
      };
    }
    case 'lastday':
      return {
        type: 'recurring',
        cron: `${minute} ${hour} 28-31 * *`,
        humanReadable: `le dernier jour du mois ${at}`,
        isLastDayOfMonth: true,
      };
    default:
      throw new Error(`Fréquence inconnue : ${freq}`);
  }
}
