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

const PARIS_DAY_LABEL = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

function parisYMD(d: Date): { year: number; month: number; day: number } {
  const parts = PARIS_YMD.formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

/** Nombre de jours proposés dans le menu déroulant « Date » (limite Discord : 25 options). */
export const DATE_OPTION_DAYS = 25;

/**
 * Options de date relatives : « Aujourd'hui », « Demain », puis les jours
 * suivants (jusqu'à 25). value = "YYYY-M-D" (calendrier Paris).
 */
export function buildDateOptions(now: Date = new Date()): SelectOpt[] {
  const today = parisYMD(now);
  // Midi UTC du jour courant : loin des bascules DST, l'ajout de N jours
  // conserve la même date murale.
  const base = Date.UTC(today.year, today.month - 1, today.day, 12, 0, 0);
  const opts: SelectOpt[] = [];
  for (let i = 0; i < DATE_OPTION_DAYS; i++) {
    const d = new Date(base + i * 86_400_000);
    const ymd = parisYMD(d);
    const dateLabel = PARIS_DAY_LABEL.format(d);
    let label = dateLabel;
    if (i === 0) label = `Aujourd'hui · ${dateLabel}`;
    else if (i === 1) label = `Demain · ${dateLabel}`;
    opts.push({ value: `${ymd.year}-${ymd.month}-${ymd.day}`, label: label.slice(0, 100) });
  }
  return opts;
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
