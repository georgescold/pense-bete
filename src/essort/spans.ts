import type { EssortPerson } from '../config';
import type { EssortSpanRow } from '../db/essortRepository';
import { zonedWallClockToUtc } from '../lib/datetime';
import { parseDayInput, PEOPLE, shortDate, weekdayName } from './planner';

/**
 * Tâches qui durent plus d'un jour, ajoutées depuis Discord :
 *  - permanente : sur le tableau de chaque jour, jusqu'à être cochée ;
 *  - période : sur le tableau de chaque jour du créneau (début → fin, jour et
 *    heure). À la fin, le bot demande si elle a pu être faite.
 *
 * Fonctions pures : jours 'YYYY-MM-DD' et heures 'HH:MM' de Paris.
 */

/** Une fin sans heure : la période court jusqu'à la question du soir. */
export const DEFAULT_END_TIME = '19:00';

export interface Moment {
  date: string;
  time: string | null;
}

// « 9h », « 14h30 », « 14:30 », « à 18h » en fin de texte. Un « h » ou un
// « : » est exigé, pour ne pas lire l'heure dans une date (« 12/10 »).
const TRAILING_TIME = /(?:^|\s)(?:à|a)?\s*([01]?\d|2[0-3])\s*(?:h\s*([0-5]\d)?|:\s*([0-5]\d))\s*$/i;

/**
 * Jour et heure tapés à la main : « lundi 9h », « 12/10 14h30 », « demain à
 * 18:00 », « 14h » (aujourd'hui), « mercredi » (sans heure).
 * Vide → null ; illisible → undefined.
 */
export function parseMomentInput(input: string, today: string): Moment | null | undefined {
  const s = input.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const m = TRAILING_TIME.exec(s);
  // Une heure écrite mais pas comprise (« 25h », « 9h du matin ») : on ne l'ignore pas.
  if (!m && /\d\s*[h:]/i.test(s)) return undefined;
  const time = m ? `${m[1]!.padStart(2, '0')}:${m[2] ?? m[3] ?? '00'}` : null;
  const rest = (m ? s.slice(0, m.index) : s).replace(/[\s,]+$/, '');
  const date = rest ? parseDayInput(rest, today) : today;
  return date ? { date, time } : undefined;
}

/** L'instant (ms) d'un jour et d'une heure de Paris. */
export function atParis(date: string, time: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return zonedWallClockToUtc({
    year: year!,
    month: month!,
    day: day!,
    hour: hour!,
    minute: minute!,
  }).getTime();
}

/**
 * Le créneau d'une période est-il valable ? Renvoie ce qui ne va pas, ou null.
 * @param kept début déjà enregistré (modification) : il peut être passé.
 */
export function periodProblem(
  start: Moment,
  end: Moment,
  today: string,
  now: number,
  kept?: Moment,
): string | null {
  const unchanged = kept && kept.date === start.date && kept.time === start.time;
  if (start.date < today && !unchanged) return 'Le début est déjà passé.';
  const endAt = atParis(end.date, end.time ?? DEFAULT_END_TIME);
  if (endAt <= now) return 'La fin est déjà passée.';
  if (atParis(start.date, start.time ?? '00:00') >= endAt) {
    return 'La fin doit venir après le début.';
  }
  return null;
}

export function isSpanOpen(span: EssortSpanRow): boolean {
  return !span.done_at && !span.dismissed_at;
}

/** La fin d'une période (ms), null pour une tâche permanente. */
export function spanEnd(span: EssortSpanRow): number | null {
  if (span.kind !== 'period' || !span.end_date || !span.end_time) return null;
  return atParis(span.end_date, span.end_time);
}

/**
 * La tâche s'affiche-t-elle sur le tableau de ce jour ? Une période finie
 * aujourd'hui y reste : sans réponse à la question, rien ne bouge.
 */
export function spanShowsOn(span: EssortSpanRow, date: string): boolean {
  if (!isSpanOpen(span) || date < span.start_date) return false;
  return span.kind === 'permanent' || (span.end_date !== null && date <= span.end_date);
}

/** L'heure de la ligne du jour : celle du début, le jour où la période commence (pings). */
export function spanRowTime(span: EssortSpanRow, date: string): string | null {
  return date === span.start_date ? span.start_time : null;
}

/** « lun. 12/10 09:00 » */
export function momentText(date: string, time: string | null): string {
  return `${weekdayName(date, true)} ${shortDate(date)}${time ? ` ${time}` : ''}`;
}

/**
 * La consigne sous la tâche, dans le message du jour. Pour toute l'équipe,
 * elle dit avec qui elle est partagée (vu du tableau de `person`).
 */
export function spanDetails(span: EssortSpanRow, date: string, person?: EssortPerson): string {
  const end = span.end_date ?? date;
  const when =
    span.kind === 'permanent'
      ? 'Tous les jours, jusqu’à ce qu’elle soit faite'
      : end === date
        ? `Jusqu’à ${span.end_time}`
        : `Jusqu’au ${weekdayName(end)} ${shortDate(end)}, ${span.end_time}`;
  const others = PEOPLE.filter((p) => p !== person);
  return span.shared && others.length > 0 ? `${when} · avec ${others.join(' et ')}` : when;
}

/** « Loys et Enzo » : toute l'équipe. */
export function teamText(): string {
  return PEOPLE.join(' et ');
}

/** « du lun. 12/10 09:00 au mer. 14/10 18:00 » */
export function periodText(span: EssortSpanRow): string {
  return `du ${momentText(span.start_date, span.start_time)} au ${momentText(
    span.end_date ?? span.start_date,
    span.end_time,
  )}`;
}

/**
 * Ce que la semaine montre d'une période : son début et sa fin, chacun sur
 * son jour (s'il est dans la semaine). Une tâche permanente est déjà dans le
 * message du jour, chaque jour : rien ici.
 */
export function spanWeekLines(
  span: EssortSpanRow,
  from: string,
  to: string,
): { date: string; time: string | null; label: string }[] {
  if (span.kind !== 'period' || !span.end_date || !isSpanOpen(span)) return [];
  const within = (d: string): boolean => d >= from && d <= to;
  const lines: { date: string; time: string | null; label: string }[] = [];
  if (within(span.start_date)) {
    const until =
      span.end_date === span.start_date
        ? `jusqu’à ${span.end_time}`
        : `jusqu’au ${momentText(span.end_date, span.end_time)}`;
    lines.push({ date: span.start_date, time: span.start_time, label: `${span.label} (${until})` });
  }
  if (span.end_date !== span.start_date && within(span.end_date)) {
    lines.push({ date: span.end_date, time: span.end_time, label: `Fin : ${span.label}` });
  }
  return lines;
}

export type SpanOutcome = 'done' | 'report' | 'drop';

/** Ce qui reste de la question de fin de période, une fois close. */
export function spanClosedText(
  span: EssortSpanRow,
  outcome: SpanOutcome,
  by: string | null,
): string {
  const who = by ? ` (${by})` : '';
  switch (outcome) {
    case 'done':
      return `✅ Faite : **${span.label}**${who}`;
    case 'report':
      return `Reportée au ${momentText(span.end_date ?? span.start_date, span.end_time)} : **${span.label}**${who}`;
    case 'drop':
      return `Abandonnée : **${span.label}**${who}`;
  }
}
