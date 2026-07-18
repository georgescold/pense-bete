import { config } from '../config';

const TZ = config.TIMEZONE;

// ---------------------------------------------------------------------------
// Conversion heure-locale-Paris → instant UTC (DST-safe)
// ---------------------------------------------------------------------------

interface YMDHM {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
}

/**
 * Convertit une heure murale dans le fuseau configuré (Europe/Paris) en un
 * instant UTC réel, en tenant compte du changement d'heure (DST).
 */
export function zonedWallClockToUtc(p: YMDHM): Date {
  const utcGuess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcGuess));
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  const asSeen = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  const offset = asSeen - utcGuess; // décalage du fuseau (ms) à cet instant
  return new Date(utcGuess - offset);
}

// ---------------------------------------------------------------------------
// Options des menus déroulants (cascade date / heure / minute)
// ---------------------------------------------------------------------------

export interface SelectOpt {
  value: string;
  label: string;
}

const PARIS_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function parisYMD(d: Date): { year: number; month: number; day: number } {
  const parts = PARIS_YMD.formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

// --- Sélecteur Période (mois × 2 moitiés) + Jour -------------------------

const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

const DAY_LABEL_FMT = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

function daysInMonth(year: number, month: number): number {
  // month 1-12 ; le "jour 0" du mois suivant = dernier jour du mois courant.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Nombre de mois proposés dans le sélecteur de période. */
export const PERIOD_MONTHS = 12;

/**
 * Options « Période » : chaque mois est scindé en deux moitiés (1–15 / 16–fin)
 * pour tenir sous la limite Discord de 25 options tout en couvrant ~1 an.
 * value = "YYYY-M-H" (H = 1 pour la 1re moitié, 2 pour la 2nde).
 */
export function buildPeriodOptions(now: Date = new Date()): SelectOpt[] {
  const today = parisYMD(now);
  const opts: SelectOpt[] = [];
  for (let i = 0; i < PERIOD_MONTHS; i++) {
    const monthIndex = today.month - 1 + i; // 0-based, peut dépasser 11
    const year = today.year + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1; // 1-12
    const last = daysInMonth(year, month);
    const name = MONTHS_FR[month - 1]!;
    for (const half of [1, 2] as const) {
      const startDay = half === 1 ? 1 : 16;
      const endDay = half === 1 ? 15 : last;
      // On saute une moitié entièrement passée (mois courant uniquement).
      if (year === today.year && month === today.month && today.day > endDay) continue;
      const label = `${name} ${year} · ${startDay}–${endDay}`;
      opts.push({ value: `${year}-${month}-${half}`, label: label.slice(0, 100) });
    }
  }
  return opts.slice(0, 25);
}

/** Jours (SelectOpt) d'une période donnée, en excluant les jours déjà passés. */
export function buildDayOptions(periodValue: string, now: Date = new Date()): SelectOpt[] {
  const [year, month, half] = periodValue.split('-').map(Number);
  if (!year || !month || !half) return [];
  const last = daysInMonth(year, month);
  const startDay = half === 1 ? 1 : 16;
  const endDay = half === 1 ? 15 : last;
  const today = parisYMD(now);
  const opts: SelectOpt[] = [];
  for (let d = startDay; d <= endDay; d++) {
    // Exclut les jours strictement avant aujourd'hui (comparaison calendaire).
    if (
      year < today.year ||
      (year === today.year && month < today.month) ||
      (year === today.year && month === today.month && d < today.day)
    ) {
      continue;
    }
    const dt = new Date(Date.UTC(year, month - 1, d, 12, 0, 0));
    opts.push({ value: `${year}-${month}-${d}`, label: DAY_LABEL_FMT.format(dt).slice(0, 100) });
  }
  return opts;
}

/** Renvoie la période ("YYYY-M-H") qui contient aujourd'hui. */
export function currentPeriodValue(now: Date = new Date()): string {
  const t = parisYMD(now);
  const half = t.day <= 15 ? 1 : 2;
  return `${t.year}-${t.month}-${half}`;
}

export function buildHourOptions(): SelectOpt[] {
  return Array.from({ length: 24 }, (_, h) => ({
    value: String(h),
    label: `${h.toString().padStart(2, '0')} h`,
  }));
}

export function buildMinuteOptions(): SelectOpt[] {
  return Array.from({ length: 12 }, (_, i) => {
    const m = i * 5;
    return { value: String(m), label: `${m.toString().padStart(2, '0')} min` };
  });
}

/** Dizaines de minutes (00,10,…,50) — 1re moitié d'une minute au pas de 1. */
export function buildMinuteTensOptions(): SelectOpt[] {
  return [0, 10, 20, 30, 40, 50].map((m) => ({
    value: String(m),
    label: `${m.toString().padStart(2, '0')} min`,
  }));
}

/** Unités de minutes (+0 … +9) — 2nde moitié, à additionner aux dizaines. */
export function buildMinuteUnitsOptions(): SelectOpt[] {
  return Array.from({ length: 10 }, (_, u) => ({ value: String(u), label: `+${u} min` }));
}

/** Valeur "YYYY-M-D" (calendrier Paris) pour aujourd'hui + offsetDays jours. */
export function parisDateValue(offsetDays: number, now: Date = new Date()): string {
  const today = parisYMD(now);
  const base = Date.UTC(today.year, today.month - 1, today.day, 12, 0, 0);
  const d = new Date(base + offsetDays * 86_400_000);
  const ymd = parisYMD(d);
  return `${ymd.year}-${ymd.month}-${ymd.day}`;
}

/** Reconstitue l'instant UTC à partir des valeurs choisies dans la cascade. */
export function selectionToDate(dateValue: string, hour: number, minute: number): Date {
  const [y, mo, d] = dateValue.split('-').map(Number);
  return zonedWallClockToUtc({
    year: y!,
    month: mo!,
    day: d!,
    hour,
    minute,
  });
}

// ---------------------------------------------------------------------------
// Échelle de relance ("réveil")
// ---------------------------------------------------------------------------

const H = 3_600_000;
const D = 86_400_000;

/**
 * Délais successifs après lesquels un rappel non validé est renvoyé.
 * Au-delà de la dernière étape, on répète la dernière valeur (1 semaine).
 */
export const ESCALATION_LADDER_MS: number[] = [4 * H, 6 * H, 1 * D, 3 * D, 7 * D];
const ESCALATION_LABELS: string[] = ['4 h', '6 h', '1 jour', '3 jours', '1 semaine'];

export function escalationDelayMs(step: number): number {
  const i = Math.min(Math.max(step, 0), ESCALATION_LADDER_MS.length - 1);
  return ESCALATION_LADDER_MS[i]!;
}

export function escalationDelayLabel(step: number): string {
  const i = Math.min(Math.max(step, 0), ESCALATION_LABELS.length - 1);
  return ESCALATION_LABELS[i]!;
}

/** Récapitulatif lisible de la séquence, pour l'affichage. */
export const ESCALATION_SUMMARY = '4 h → 6 h → 1 j → 3 j → 1 sem., puis chaque semaine';
