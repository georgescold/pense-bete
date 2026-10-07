import type { EssortPerson } from '../config';
import type { Lead } from './airtable';

/**
 * Transforme les leads Airtable en agenda par personne : le jour et la semaine.
 *
 * Fonctions pures (aucun accès réseau ni base) : tout se teste avec des
 * leads fabriqués et une date « aujourd'hui » imposée.
 *
 * Règles de lecture :
 *  - la date de référence est « date de la prochaine action » ;
 *  - à défaut, on la lit dans « Prochain événement » (« jeudi 08/10 »,
 *    « fin octobre »…) ;
 *  - l'heure vient de « Prochain événement » (« à 11h »), si ce texte parle
 *    bien du même jour ;
 *  - « Gestion » désigne le tableau (Loys ou Enzo) ;
 *  - un lead « dead » disparaît ;
 *  - échu (date ≤ aujourd'hui) = tâche du jour, en retard compris ;
 *  - dans les 6 jours suivants = planning de la semaine.
 */

export const PEOPLE: readonly EssortPerson[] = ['Loys', 'Enzo'];
/** La semaine affichée : les 6 jours qui suivent aujourd'hui. */
export const WEEK_DAYS = 6;

// ---------------------------------------------------------------------------
// Dates murales 'YYYY-MM-DD' (aucun fuseau : ce sont des jours, pas des instants)
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

function fromDayNumber(n: number): string {
  const d = new Date(n * 86_400_000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/** Nombre de jours de `from` à `to` (positif si `to` est après). */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

export function addDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days);
}

/** '2026-8-5' → '2026-08-05' : les helpers de datetime ne complètent pas les zéros. */
export function padDate(date: string): string {
  const m = ISO_DATE.exec(date);
  if (!m) return date;
  return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
}

function makeDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return fromDayNumber(Math.round(d.getTime() / 86_400_000));
}

/** Sans année écrite, on retient celle qui place la date au plus près d'aujourd'hui. */
function nearestDate(month: number, day: number, today: string): string | null {
  const year = Number(today.slice(0, 4));
  let best: string | null = null;
  for (const y of [year - 1, year, year + 1]) {
    const candidate = makeDate(y, month, day);
    if (!candidate) continue;
    if (!best || Math.abs(daysBetween(today, candidate)) < Math.abs(daysBetween(today, best))) {
      best = candidate;
    }
  }
  return best;
}

const MONTHS: Record<string, number> = {
  janvier: 1,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
};

/** « début / mi / fin » d'un mois : on se cale sur ces jours-là. */
const MONTH_PART_DAY: Record<string, number> = { debut: 1, mi: 15, fin: 25 };

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// « 08/10 », « 8.10 », « 08/10/2026 ». Ni précédé ni suivi d'autres chiffres
// séparés, pour ne pas lire une date dans un numéro de téléphone.
const NUMERIC_DATE =
  /(?<![\d./])(\d{1,2})\s*[/.]\s*(\d{1,2})(?:\s*[/.]\s*(\d{4}|\d{2}))?(?![./]?\d)/g;
const MONTH_PART = new RegExp(
  `(?<![a-z])(debut|mi|fin)[\\s-]+(?:d'\\s*)?(${Object.keys(MONTHS).join('|')})`,
  'i',
);

/**
 * Lit une date dans un texte libre comme « A appeler jeudi 08/10 » ou
 * « à relancer fin octobre ». Renvoie 'YYYY-MM-DD' ou null.
 */
export function parseEventDate(text: string | null, today: string): string | null {
  if (!text) return null;
  const plain = stripAccents(text).replace(/[’]/g, "'").toLowerCase();

  for (const m of plain.matchAll(NUMERIC_DATE)) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const rawYear = m[3];
    if (rawYear) {
      const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
      const date = makeDate(year, month, day);
      if (date) return date;
    } else {
      const date = nearestDate(month, day, today);
      if (date) return date;
    }
  }

  const part = MONTH_PART.exec(plain);
  if (part) {
    const day = MONTH_PART_DAY[part[1]!] ?? 1;
    const month = MONTHS[part[2]!];
    if (month) return nearestDate(month, day, today);
  }
  return null;
}

// « 11h », « 10 h », « 16h30 », « 14:30 ». Pas « 24h » ni un chiffre isolé.
const TIME = /(?<![\d:.])([01]?\d|2[0-3])\s*(?:h|:)\s*([0-5]\d)?(?![\d])/;

/** Première heure écrite dans un texte, au format 'HH:MM'. */
export function parseTime(text: string | null): string | null {
  if (!text) return null;
  const m = TIME.exec(text.toLowerCase());
  if (!m) return null;
  return `${m[1]!.padStart(2, '0')}:${m[2] ?? '00'}`;
}

export interface DueDate {
  date: string;
  /** Vrai si la date vient du texte « Prochain événement » et non du champ date. */
  inferred: boolean;
}

export function resolveDueDate(lead: Lead, today: string): DueDate | null {
  if (lead.dateAction && ISO_DATE.test(lead.dateAction)) {
    return { date: padDate(lead.dateAction), inferred: false };
  }
  const parsed = parseEventDate(lead.prochainEvenement, today);
  return parsed ? { date: parsed, inferred: true } : null;
}

// ---------------------------------------------------------------------------
// Libellés
// ---------------------------------------------------------------------------

type ActionKind =
  | 'call'
  | 'r1'
  | 'r2'
  | 'relance'
  | 'doc'
  | 'en_cours'
  | 'retour'
  | 'dead'
  | 'other'
  | 'none';

/** Action Airtable normalisée : « A relancer ( une date ) » → « a relancer ( une date ) ». */
function normalizeAction(action: string | null): string {
  return stripAccents(action ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function actionKind(action: string | null): ActionKind {
  const a = normalizeAction(action);
  if (!a) return 'none';
  if (a.includes('dead')) return 'dead';
  if (a.includes('call') || a.includes('appel')) return 'call';
  if (/^r\s?1\b/.test(a)) return 'r1';
  if (/^r\s?2\b/.test(a)) return 'r2';
  if (a.includes('relanc')) return 'relance';
  if (a.includes('doc')) return 'doc';
  if (a.includes('en cours')) return 'en_cours';
  if (a.includes('retour')) return 'retour';
  return 'other';
}

/** « Prénom · Cabinet », sans répéter quand les deux se confondent. */
export function leadName(lead: Lead): string {
  const nom = lead.nom;
  const cabinet = lead.cabinet;
  if (nom && cabinet && nom.toLowerCase() !== cabinet.toLowerCase()) return `${nom} · ${cabinet}`;
  return nom ?? cabinet ?? lead.email ?? 'Lead sans nom';
}

export function taskLabel(lead: Lead): string {
  const who = leadName(lead);
  switch (actionKind(lead.action)) {
    case 'call':
      return `📞 Appeler ${who}`;
    case 'r1':
      return `🤝 R1 avec ${who}`;
    case 'r2':
      return `🤝 R2 avec ${who}`;
    case 'relance':
      return `🔁 Relancer ${who}`;
    case 'doc':
      return `📄 Documents · ${who}`;
    case 'en_cours':
      return `▶️ Suivi · ${who}`;
    case 'retour':
      return `💬 Retour client · ${who}`;
    case 'other':
      return `📌 ${lead.action} · ${who}`;
    default:
      return `📌 Prochaine action · ${who}`;
  }
}

/** 'YYYY-MM-DD' → '08/10'. */
export function shortDate(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

function truncateText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * L'heure de l'action : celle de « Prochain événement », sauf si ce texte
 * parle d'un autre jour (« Lundi 12/10 à 11h » pour une préparation le 08/10).
 */
export function dueTime(lead: Lead, due: DueDate, today: string): string | null {
  const eventDate = parseEventDate(lead.prochainEvenement, today);
  if (eventDate && eventDate !== due.date) return null;
  return parseTime(lead.prochainEvenement);
}

/** Juste ce qu'il faut pour agir : la consigne, le téléphone, un retard éventuel. */
export function taskDetails(lead: Lead, due: DueDate, today: string): string {
  const parts: string[] = [];
  if (lead.prochainEvenement) parts.push(truncateText(lead.prochainEvenement, 120));
  if (lead.telephone) parts.push(`☎ ${lead.telephone}`);
  if (daysBetween(due.date, today) > 0) parts.push(`prévu le ${shortDate(due.date)}`);
  return parts.join(' · ');
}

/** Identifie « cette » action d'un lead : une fois validée, elle ne revient pas. */
export function signatureOf(lead: Lead, due: DueDate): string {
  return `${normalizeAction(lead.action) || 'none'}|${due.date}`;
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

export interface DueTask {
  recordId: string;
  signature: string;
  label: string;
  details: string;
  dueDate: string;
  /** 'HH:MM' ou null. */
  time: string | null;
}

export interface UpcomingItem {
  date: string;
  time: string | null;
  label: string;
}

export interface PersonAgenda {
  /** À faire aujourd'hui (retards compris). */
  due: DueTask[];
  /** Les 6 jours suivants. */
  upcoming: UpcomingItem[];
}

export interface Agenda {
  people: Record<EssortPerson, PersonAgenda>;
}

function personOf(lead: Lead): EssortPerson | null {
  const g = lead.gestion?.trim().toLowerCase();
  return PEOPLE.find((p) => p.toLowerCase() === g) ?? null;
}

/** Les leads chauds d'abord à date égale. */
function heat(lead: Lead): number {
  const v = stripAccents(lead.verdict ?? '').toLowerCase();
  if (v.includes('chaud')) return 0;
  if (v.includes('tiede')) return 1;
  if (v.includes('froid')) return 2;
  return 3;
}

/** Tri d'une journée : les heures fixes d'abord, dans l'ordre. */
export function compareTime(a: string | null, b: string | null): number {
  if (a && b) return a.localeCompare(b);
  if (a) return -1;
  if (b) return 1;
  return 0;
}

export function buildAgenda(leads: Lead[], today: string, weekDays = WEEK_DAYS): Agenda {
  const people = Object.fromEntries(
    PEOPLE.map((p) => [p, { due: [], upcoming: [] } as PersonAgenda]),
  ) as Record<EssortPerson, PersonAgenda>;
  const heats = new Map<string, number>();

  for (const lead of leads) {
    if (actionKind(lead.action) === 'dead') continue;
    const person = personOf(lead);
    const due = resolveDueDate(lead, today);
    if (!person || !due) continue;

    const agenda = people[person];
    const delta = daysBetween(today, due.date);
    const time = dueTime(lead, due, today);
    if (delta <= 0) {
      agenda.due.push({
        recordId: lead.id,
        signature: signatureOf(lead, due),
        label: taskLabel(lead),
        details: taskDetails(lead, due, today),
        dueDate: due.date,
        time,
      });
      heats.set(lead.id, heat(lead));
    } else if (delta <= weekDays) {
      agenda.upcoming.push({ date: due.date, time, label: taskLabel(lead) });
    }
  }

  for (const agenda of Object.values(people)) {
    // Retards d'abord, puis par heure, puis les leads chauds.
    agenda.due.sort(
      (a, b) =>
        a.dueDate.localeCompare(b.dueDate) ||
        compareTime(a.time, b.time) ||
        (heats.get(a.recordId) ?? 3) - (heats.get(b.recordId) ?? 3),
    );
    agenda.upcoming.sort((a, b) => a.date.localeCompare(b.date) || compareTime(a.time, b.time));
  }

  return { people };
}

/**
 * Heure tapée à la main : « 14h30 », « 14h », « 14:30 », « 9 ».
 * Vide → null (pas d'heure) ; illisible → undefined.
 */
export function parseTimeInput(input: string): string | null | undefined {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const m = /^([01]?\d|2[0-3])\s*(?:[h:]\s*([0-5]\d)?)?$/.exec(s);
  if (!m) return undefined;
  return `${m[1]!.padStart(2, '0')}:${m[2] ?? '00'}`;
}

/** 'YYYY-MM-DD' → 'jeudi' (ou 'jeu.' en court). */
export function weekdayName(date: string, short = false): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12)).toLocaleDateString('fr-FR', {
    weekday: short ? 'short' : 'long',
    timeZone: 'UTC',
  });
}
