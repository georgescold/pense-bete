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
 *  - pour un rendez-vous (appel, R1, R2) dont le texte donne une date plus
 *    tardive (« Lundi 12/10 à 11h »), le champ date est celui de la
 *    préparation : « Préparer le R2 » ce jour-là, le R2 lui-même à sa date ;
 *  - un rendez-vous dont le texte dit « doc à préparer » le jour même amène
 *    « Préparer le R2 » le jour ouvré d'avant ;
 *  - un texte à plusieurs dates n'est lu que pour la partie qui concerne la
 *    date de l'action ; un texte dont toutes les dates sont passées par
 *    rapport à l'action raconte l'événement précédent : il est ignoré ;
 *  - quand « Action » décrit un état (« Attente de doc », « A relancer »…)
 *    et que le texte dit quoi faire (« appel téléphonique », « R2 »), c'est
 *    le texte qui nomme la tâche ;
 *  - « Gestion » désigne le tableau (Loys ou Enzo) ; vide, le prénom de
 *    l'équipe cité dans le texte (« Enzo appelle Hélène ») ;
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
const MONTH_PART_ALL = new RegExp(MONTH_PART.source, 'gi');

/** Toutes les dates écrites dans un texte, dans l'ordre, sans doublon. */
export function textDates(text: string | null, today: string): string[] {
  if (!text) return [];
  const plain = stripAccents(text).replace(/[’]/g, "'").toLowerCase();
  const dates: string[] = [];
  for (const m of plain.matchAll(NUMERIC_DATE)) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const rawYear = m[3];
    const date = rawYear
      ? makeDate(rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear), month, day)
      : nearestDate(month, day, today);
    if (date) dates.push(date);
  }
  for (const m of plain.matchAll(MONTH_PART_ALL)) {
    const month = MONTHS[m[2]!];
    const date = month ? nearestDate(month, MONTH_PART_DAY[m[1]!] ?? 1, today) : null;
    if (date) dates.push(date);
  }
  return [...new Set(dates)];
}

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

/**
 * La date de l'action : le champ date ; à défaut, la première date à venir du
 * texte (« Doc envoyé le 09/10, rappeler le 13/10 » → le 13/10), sinon la
 * plus récente.
 */
export function resolveDueDate(lead: Lead, today: string): DueDate | null {
  if (lead.dateAction && ISO_DATE.test(lead.dateAction)) {
    return { date: padDate(lead.dateAction), inferred: false };
  }
  const dates = [...textDates(lead.prochainEvenement, today)].sort();
  if (dates.length === 0) return null;
  return { date: dates.find((d) => d >= today) ?? dates[dates.length - 1]!, inferred: true };
}

// ---------------------------------------------------------------------------
// Libellés
// ---------------------------------------------------------------------------

export type ActionKind =
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

/** Libellé en texte seul : les emojis se rendent mal et alourdissent la liste. */
export function taskLabel(lead: Lead, kind: ActionKind = actionKind(lead.action)): string {
  const who = leadName(lead);
  switch (kind) {
    case 'call':
      return `Appeler ${who}`;
    case 'r1':
      return `R1 avec ${who}`;
    case 'r2':
      return `R2 avec ${who}`;
    case 'relance':
      return `Relancer ${who}`;
    case 'doc':
      return `Documents : ${who}`;
    case 'en_cours':
      return `Suivi : ${who}`;
    case 'retour':
      return `Retour client : ${who}`;
    case 'other':
      return `${lead.action} : ${who}`;
    default:
      return `Prochaine action : ${who}`;
  }
}

/** « Préparer le R2 avec … » : le jour du champ date, avant le rendez-vous. */
export function prepLabel(lead: Lead, kind: ActionKind = actionKind(lead.action)): string {
  const who = leadName(lead);
  switch (kind) {
    case 'call':
      return `Préparer l'appel avec ${who}`;
    case 'r1':
      return `Préparer le R1 avec ${who}`;
    case 'r2':
      return `Préparer le R2 avec ${who}`;
    default:
      return `Préparer : ${taskLabel(lead, kind)}`;
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

// « Jeudi 08/10 », « le 08/10 », « jeu. 8.10.2026 », « pour mardi 13/10 ».
const DATE_PHRASE =
  /(?:pour\s+)?(?:(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|lun|mar|mer|jeu|ven|sam|dim)\.?\s+)?(?:le\s+)?(?<![\d./])\d{1,2}\s*[/.]\s*\d{1,2}(?:\s*[/.]\s*(?:\d{4}|\d{2}))?(?![./]?\d)/gi;
// « à 11h », « à 9h30 », « 14:00 ».
const AT_TIME = /à\s*(?<![\d:.])(?:[01]?\d|2[0-3])\s*(?:h|:)\s*(?:[0-5]\d)?(?!\d)/gi;

/**
 * La consigne de « Prochain événement » sans ce que la tâche affiche déjà :
 * « Jeudi 08/10 appel téléphonique à 11h » devient « Appel téléphonique »
 * sur la tâche de 11h du 08/10. Une date ou une heure différentes restent :
 * elles disent quelque chose (« Lundi 12/10 à 11h » sur une préparation).
 */
export function eventNote(
  text: string | null,
  date: string,
  time: string | null,
  today: string,
): string | null {
  if (!text) return null;
  let note = text.replace(DATE_PHRASE, (m) => (parseEventDate(m, today) === date ? ' ' : m));
  if (time) note = note.replace(AT_TIME, (m) => (parseTime(m) === time ? ' ' : m));
  note = note
    .replace(/\s+/g, ' ')
    .replace(/\s+([,).])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/^[\s\-–—·,:]+|[\s\-–—·,:]+$/g, '');
  if (!note) return null;
  return note.charAt(0).toUpperCase() + note.slice(1);
}

/** Le téléphone ne sert que s'il faut appeler : un appel, une relance, ou un texte qui le dit. */
function needsPhone(step: LeadStep): boolean {
  if (step.prep) return false;
  if (step.kind === 'call' || step.kind === 'relance') return true;
  return /appel|t[eé]l[eé]phon/i.test(step.note ?? '');
}

/** Juste ce qu'il faut pour agir : la consigne, le téléphone s'il faut appeler, un retard. */
export function taskDetails(lead: Lead, step: LeadStep, today: string): string {
  const parts: string[] = [];
  if (step.note) parts.push(truncateText(step.note, 120));
  if (lead.telephone && needsPhone(step)) parts.push(`☎ ${lead.telephone}`);
  if (daysBetween(step.date, today) > 0) parts.push(`en retard, prévu le ${shortDate(step.date)}`);
  return parts.join(' · ');
}

/** Identifie « cette » action d'un lead : une fois validée, elle ne revient pas. */
export function signatureOf(lead: Lead, date: string): string {
  return `${normalizeAction(lead.action) || 'none'}|${date}`;
}

/** Actions qui sont un rendez-vous fixé à une date. */
const MEETING_KINDS: ReadonlySet<ActionKind> = new Set(['call', 'r1', 'r2']);

/** Découpe « A - B, C · D » en morceaux, pour isoler ce qui concerne une date. */
function segmentsOf(text: string): string[] {
  return text
    .split(/\s+[-–—·]\s+|\s*;\s*|,\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface TextReading {
  /** Ce que le texte dit de l'action à cette date, ou null. */
  note: string | null;
  time: string | null;
}

/**
 * Ce que dit « Prochain événement » de l'action prévue à `date` :
 *  - texte sans date, ou qui ne parle que de cette date : tel quel ;
 *  - texte à plusieurs dates : seuls les morceaux qui citent cette date
 *    (« Doc envoyé le 09/10 - appel mardi 13/10 matin » → « appel … matin ») ;
 *  - texte dont toutes les dates sont passées et précèdent l'action : il
 *    raconte l'événement d'avant (« Vendredi 09/10 appel » pour un R2 le
 *    14/10, lu le 10/10), on l'ignore ;
 *  - texte qui parle d'un moment plus tardif : il éclaire la tâche (« Lundi
 *    12/10 à 11h » sur une préparation) sans lui donner son heure.
 */
export function readTextFor(text: string | null, date: string, today: string): TextReading {
  if (!text) return { note: null, time: null };
  const dates = textDates(text, today);
  if (dates.length === 0) return { note: text, time: parseTime(text) };
  if (dates.includes(date)) {
    if (dates.length === 1) return { note: text, time: parseTime(text) };
    const own = segmentsOf(text)
      .filter((part) => textDates(part, today).includes(date))
      .join(' · ');
    return { note: own || text, time: parseTime(own || text) };
  }
  // Seulement si ces dates sont aussi passées : un appel encore à venir
  // aujourd'hui, avant un R2 plus tard, reste affiché.
  if (dates.every((d) => d < date && d < today)) return { note: null, time: null };
  return { note: text, time: null };
}

/**
 * L'action à mener : celle de la colonne « Action », sauf quand elle décrit
 * un état (« Attente de doc », « A relancer »…) et que le texte dit quoi
 * faire (« proposition d'appel téléphonique mardi 13/10 », « R2 lundi »).
 */
export function stepKind(lead: Lead, note: string | null): ActionKind {
  const base = actionKind(lead.action);
  if (MEETING_KINDS.has(base) || base === 'dead' || !note) return base;
  const t = stripAccents(note).toLowerCase();
  if (/\br\s?2\b/.test(t)) return 'r2';
  if (/\br\s?1\b/.test(t)) return 'r1';
  if (/appel|telephon|\bcall\b/.test(t)) return 'call';
  return base;
}

/** Jour ouvré précédent : la veille, ou le vendredi pour un lundi ou un week-end. */
export function previousBusinessDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12)).getUTCDay();
  const back = weekday === 1 ? 3 : weekday === 0 ? 2 : 1;
  return addDays(date, -back);
}

export interface LeadStep {
  date: string;
  /** 'HH:MM' ou null. */
  time: string | null;
  label: string;
  signature: string;
  /** Vrai pour la préparation d'un rendez-vous, avant le rendez-vous lui-même. */
  prep: boolean;
  /** L'action effective (colonne « Action », précisée par le texte). */
  kind: ActionKind;
  /** La consigne affichée sous la tâche, sans la date ni l'heure déjà montrées. */
  note: string | null;
}

/**
 * Ce qu'un lead met à l'agenda : en général une seule étape. Pour un
 * rendez-vous à venir dont le texte donne une date plus tardive que le champ
 * date, deux : la préparation (date du champ) puis le rendez-vous (date et
 * heure du texte). Un rendez-vous à venir qui demande « doc à préparer » le
 * jour même : la préparation le jour ouvré d'avant. Un rendez-vous passé ne
 * laisse que lui-même, en retard.
 */
export function leadSteps(lead: Lead, today: string): LeadStep[] {
  const due = resolveDueDate(lead, today);
  if (!due) return [];
  const text = lead.prochainEvenement;
  const main = readTextFor(text, due.date, today);
  const kind = stepKind(lead, main.note);
  const later = [...textDates(text, today)].sort().find((d) => d > due.date && d >= today);

  if (MEETING_KINDS.has(kind) && later) {
    const event = readTextFor(text, later, today);
    return [
      {
        date: due.date,
        time: null,
        label: prepLabel(lead, kind),
        signature: signatureOf(lead, due.date),
        prep: true,
        kind,
        note: eventNote(text, due.date, null, today),
      },
      {
        date: later,
        time: event.time,
        label: taskLabel(lead, kind),
        signature: signatureOf(lead, later),
        prep: false,
        kind,
        note: eventNote(event.note, later, event.time, today),
      },
    ];
  }

  const steps: LeadStep[] = [
    {
      date: due.date,
      time: main.time,
      label: taskLabel(lead, kind),
      signature: signatureOf(lead, due.date),
      prep: false,
      kind,
      note: eventNote(main.note, due.date, main.time, today),
    },
  ];
  if (MEETING_KINDS.has(kind) && due.date >= today && /pr[eé]par/i.test(main.note ?? '')) {
    const prepDate = previousBusinessDay(due.date);
    steps.unshift({
      date: prepDate,
      time: null,
      label: prepLabel(lead, kind),
      signature: signatureOf(lead, prepDate),
      prep: true,
      kind,
      note: eventNote(text, prepDate, null, today),
    });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

/** De quoi reconnaître une action du CRM dans une tâche écrite à la main. */
export interface CrmMatch {
  /** Prénom, nom, nom du cabinet du lead, sans les mots trop courants. */
  names: string[];
  /** Un rendez-vous (appel, R1, R2), pas sa préparation. */
  meeting: boolean;
  /** La préparation d'un rendez-vous. */
  prep: boolean;
}

export interface DueTask {
  recordId: string;
  signature: string;
  label: string;
  details: string;
  dueDate: string;
  /** 'HH:MM' ou null. */
  time: string | null;
  match: CrmMatch;
}

export interface UpcomingItem {
  date: string;
  time: string | null;
  label: string;
  match: CrmMatch;
}

/** Une action lue dans le CRM, quelle que soit sa date. */
export interface CrmAction {
  /** Lead + action + date : la même clé tant que rien ne change dans Airtable. */
  key: string;
  date: string;
  time: string | null;
  label: string;
  match: CrmMatch;
}

export interface PersonAgenda {
  /** À faire aujourd'hui (retards compris). */
  due: DueTask[];
  /** Les 6 jours suivants. */
  upcoming: UpcomingItem[];
  /** Toutes les actions de la personne, pour dire ce qui a changé dans le CRM. */
  actions: CrmAction[];
}

export interface Agenda {
  people: Record<EssortPerson, PersonAgenda>;
}

/**
 * Qui gère le client : la colonne « Gestion ». Vide, le seul prénom de
 * l'équipe cité dans « Prochain événement » (« Enzo appelle Hélène »).
 */
export function personOf(lead: Lead): EssortPerson | null {
  const g = lead.gestion?.trim().toLowerCase();
  const managed = PEOPLE.find((p) => p.toLowerCase() === g);
  if (managed) return managed;
  const text = stripAccents(lead.prochainEvenement ?? '').toLowerCase();
  const named = PEOPLE.filter((p) => new RegExp(`\\b${p.toLowerCase()}\\b`).test(text));
  return named.length === 1 ? named[0]! : null;
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
    PEOPLE.map((p) => [p, { due: [], upcoming: [], actions: [] } as PersonAgenda]),
  ) as Record<EssortPerson, PersonAgenda>;
  const heats = new Map<string, number>();

  for (const lead of leads) {
    if (actionKind(lead.action) === 'dead') continue;
    const person = personOf(lead);
    if (!person) continue;

    const agenda = people[person];
    const names = leadTokens(lead);
    for (const step of leadSteps(lead, today)) {
      const match: CrmMatch = {
        names,
        meeting: MEETING_KINDS.has(step.kind) && !step.prep,
        prep: step.prep,
      };
      agenda.actions.push({
        key: `${lead.id}|${step.signature}`,
        date: step.date,
        time: step.time,
        label: step.label,
        match,
      });
      const delta = daysBetween(today, step.date);
      if (delta <= 0) {
        agenda.due.push({
          recordId: lead.id,
          signature: step.signature,
          label: step.label,
          details: taskDetails(lead, step, today),
          dueDate: step.date,
          time: step.time,
          match,
        });
        heats.set(lead.id, heat(lead));
      } else if (delta <= weekDays) {
        agenda.upcoming.push({ date: step.date, time: step.time, label: step.label, match });
      }
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
    agenda.actions.sort((a, b) => a.date.localeCompare(b.date) || compareTime(a.time, b.time));
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

// ---------------------------------------------------------------------------
// Pings avant une tâche à heure fixe
// ---------------------------------------------------------------------------

/** Une tâche à heure fixe sonne 1 h, 30 min puis 10 min avant. */
export const PING_OFFSETS_MIN = [60, 30, 10] as const;

/**
 * Les pings à programmer pour une tâche qui commence à `start` (ms) et en a
 * déjà reçu `sent` : chacun avec son attente. Ceux dont l'heure est passée
 * (redémarrage du bot, tâche ajoutée tard) ne partent pas tous d'un coup :
 * seul le plus récent part tout de suite, si la tâche n'a pas commencé.
 */
export function pingPlan(
  start: number,
  sent: number,
  now: number,
): { index: number; delay: number }[] {
  const plan: { index: number; delay: number }[] = [];
  let catchUp: number | null = null;
  PING_OFFSETS_MIN.forEach((offset, index) => {
    if (index < sent) return;
    const at = start - offset * 60_000;
    if (at > now) plan.push({ index, delay: at - now });
    else catchUp = index;
  });
  if (catchUp !== null && start > now) plan.unshift({ index: catchUp, delay: 0 });
  return plan;
}

/** « dans 1 h », « dans 30 min », « dans 1 h 05 », « maintenant ». */
export function untilText(start: number, now: number): string {
  const minutes = Math.round((start - now) / 60_000);
  if (minutes <= 0) return 'maintenant';
  if (minutes < 60) return `dans ${minutes} min`;
  const rest = minutes % 60;
  return `dans ${Math.floor(minutes / 60)} h${rest ? ` ${String(rest).padStart(2, '0')}` : ''}`;
}

// ---------------------------------------------------------------------------
// Doublons : une tâche ajoutée à la main qui est déjà l'action du CRM
// ---------------------------------------------------------------------------

/** Mots trop courants pour reconnaître un lead (« Atelier », « Architecture »…). */
const GENERIC_WORDS = new Set([
  'atelier',
  'architecture',
  'architectures',
  'architecte',
  'architectes',
  'cabinet',
  'agence',
  'studio',
  'design',
  'designer',
  'interior',
  'interieur',
  'project',
  'projects',
  'maison',
  'bureau',
  'conseil',
  'renovation',
]);

function words(text: string): string[] {
  return stripAccents(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Les mots qui désignent un lead : prénom, nom, nom du cabinet. */
export function leadTokens(lead: Lead): string[] {
  const all = words(`${lead.nom ?? ''} ${lead.cabinet ?? ''}`);
  return [...new Set(all.filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w)))];
}

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

const MEETING_WORDS =
  /\b(rdv|rendez|r1|r2|r3|visio|reunion|appel|appeler|rappeler|call|tel|telephone|meet)\b/;
const OTHER_ACTION_WORDS =
  /\b(envoyer|envoi|preparer|prepa|preparation|mail|mails|doc|docs|document|documents|devis|facture|relancer)\b/;

/**
 * Une tâche écrite à la main est-elle déjà cette action du CRM ? Même jour
 * (à vérifier par l'appelant), même lead (son nom ou son cabinet dans le
 * texte), et :
 *  - même heure, à 15 min près ;
 *  - ou, une heure manquant d'un côté : deux rendez-vous (« rdv », « visio »,
 *    « appel »… mais pas « envoyer le doc du R2 »), ou deux préparations.
 * Deux heures différentes : deux moments distincts, on garde les deux.
 */
export function duplicatesCrm(
  manual: { label: string; time: string | null },
  crm: { time: string | null; match?: CrmMatch },
): boolean {
  if (!crm.match) return false;
  const plain = words(manual.label);
  if (!crm.match.names.some((n) => plain.includes(n))) return false;
  const manualTime = manual.time ?? parseTime(manual.label);
  if (manualTime && crm.time) return Math.abs(minutesOf(manualTime) - minutesOf(crm.time)) <= 15;
  const text = plain.join(' ');
  if (crm.match.prep) return /\bprepa/.test(text);
  return crm.match.meeting && MEETING_WORDS.test(text) && !OTHER_ACTION_WORDS.test(text);
}
