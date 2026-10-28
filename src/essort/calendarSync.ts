import { config, type EssortPerson } from '../config';
import {
  listAirtableTasksFor,
  listPlannedTasks,
  type EssortTaskRow,
  type TaskWithBoard,
} from '../db/essortRepository';
import {
  deleteEvent,
  insertEvent,
  isCalendarConfigured,
  listEvents,
  updateEvent,
  type CalendarEvent,
  type EventBody,
} from '../lib/calendar';
import { zonedWallClockToUtc } from '../lib/datetime';
import { logger } from '../logger';
import { recordUrl } from './crm';
import {
  addDays,
  duplicatesCrm,
  looksLikeMeeting,
  PEOPLE,
  significantWords,
  type Agenda,
} from './planner';

/**
 * L'agenda Google suit les rendez-vous à heure fixe : actions du CRM qui ont
 * une heure, tâches posées depuis Discord avec une heure (même règles que le
 * planning : une tâche écrite à la main l'emporte sur l'action du CRM qui dit
 * la même chose, une action retirée ou modifiée sur Discord l'est aussi dans
 * l'agenda). Un rendez-vous client dont l'heure n'est pas encore fixée attend
 * dans le bandeau « toute la journée », puis passe sur son créneau quand
 * l'heure est écrite. Sens unique : ce qui est changé dans l'agenda ne remonte pas.
 *
 * Le bot ne touche qu'aux événements qu'il a écrits (marqués par une clé
 * privée), et seulement à partir d'aujourd'hui : le passé reste tel quel. Un
 * rendez-vous déjà écrit à la main dans l'agenda (même créneau à 15 min près,
 * nom du lead dans le titre) l'emporte : le bot n'en crée pas un second.
 */

/** Jusqu'où l'agenda suit, en jours : au-delà, rien n'est créé ni supprimé. */
export const HORIZON_DAYS = 90;

/** Clé privée des événements écrits par le bot : les autres ne sont jamais touchés. */
const KEY_PROPERTY = 'essortKey';

/** Écart toléré entre un rendez-vous écrit à la main dans l'agenda et celui du bot. */
const SAME_SLOT_MS = 15 * 60_000;

/** Mots d'une tâche écrite à la main qui ne désignent pas le lead. */
const TASK_WORDS = new Set([
  'avec',
  'pour',
  'appel',
  'appeler',
  'rappeler',
  'relancer',
  'relance',
  'preparer',
  'prochaine',
  'action',
  'suivi',
  'retour',
  'client',
  'documents',
  'envoyer',
  'visio',
  'rendez',
  'vous',
  'loys',
  'enzo',
]);

export interface WantedEvent {
  /** 'crm:<lead>|<action>|<date>' pour une action du CRM, 'task:<id>' pour une tâche écrite. */
  key: string;
  person: EssortPerson;
  date: string;
  /** 'HH:MM', ou null : rendez-vous client dont l'heure n'est pas encore fixée (toute la journée). */
  time: string | null;
  label: string;
  details: string | null;
  recordId: string | null;
  /** Les mots qui désignent le lead, pour reconnaître un rendez-vous écrit à la main. */
  names: string[];
  /** Durée d'une tâche du calendrier du CRM ; sinon la durée par défaut. */
  minutes?: number;
}

function startOf(date: string, time: string): number {
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

function dayStart(date: string): number {
  return startOf(date, '00:00');
}

function taskWords(label: string): string[] {
  return significantWords(label).filter((w) => !TASK_WORDS.has(w));
}

/**
 * Les rendez-vous qui doivent être dans l'agenda, du jour `today` (inclus) à
 * `until` (exclu).
 * @param tasks tâches non retirées posées sur ces jours (Discord, CRM, reports)
 * @param handled toutes les tâches déjà créées pour les leads du CRM, retirées comprises
 */
export function wantedEvents(
  agenda: Agenda,
  tasks: TaskWithBoard[],
  handled: EssortTaskRow[],
  today: string,
  until: string,
): WantedEvent[] {
  const inWindow = (date: string): boolean => date >= today && date < until;
  const actions = new Map(
    PEOPLE.flatMap((person) => agenda.people[person].actions.map((a) => [a.key, { person, a }])),
  );
  const wanted: WantedEvent[] = [];

  // Les tâches du planning : celles du CRM gardent la clé de leur action, pour
  // que l'événement reste le même quand l'action devient une tâche du jour.
  for (const t of tasks) {
    const date = t.essort_boards.board_date;
    // Une tâche permanente ou une période n'est pas un rendez-vous : pas d'agenda.
    if (t.dismissed_at || t.span_id || !inWindow(date)) continue;
    const crmKey =
      t.source === 'airtable' && t.record_id && t.signature
        ? `${t.record_id}|${t.signature}`
        : null;
    const action = crmKey ? actions.get(crmKey)?.a : undefined;
    // Sans heure, seul un rendez-vous client attend son créneau dans l'agenda.
    const meeting = action
      ? action.match.meeting
      : t.source === 'manual' && looksLikeMeeting(t.label);
    if (!t.due_time && !meeting) continue;
    wanted.push({
      key: crmKey ? `crm:${crmKey}` : `task:${t.id}`,
      person: t.essort_boards.person,
      date,
      time: t.due_time,
      label: t.label,
      details: t.details,
      recordId: t.record_id,
      names: action?.match.names ?? taskWords(t.label),
      ...(action?.minutes ? { minutes: action.minutes } : {}),
    });
  }

  // Les actions du CRM pas encore devenues des tâches. Une action qui a déjà sa
  // tâche (faite, retirée, modifiée) passe par elle.
  const represented = new Set(
    handled.filter((t) => t.record_id && t.signature).map((t) => `${t.record_id}|${t.signature}`),
  );
  for (const { person, a } of actions.values()) {
    if ((!a.time && !a.match.meeting) || !inWindow(a.date) || represented.has(a.key)) continue;
    const written = tasks.some(
      (t) =>
        t.source === 'manual' &&
        t.essort_boards.person === person &&
        t.essort_boards.board_date === a.date &&
        duplicatesCrm({ label: t.label, time: t.due_time }, a),
    );
    if (written) continue;
    wanted.push({
      key: `crm:${a.key}`,
      person,
      date: a.date,
      time: a.time,
      label: a.label,
      details: a.details || null,
      recordId: a.key.split('|')[0] ?? null,
      names: a.match.names,
      ...(a.minutes ? { minutes: a.minutes } : {}),
    });
  }

  return wanted.sort(
    (x, y) => x.date.localeCompare(y.date) || (x.time ?? '').localeCompare(y.time ?? ''),
  );
}

export function eventBody(w: WantedEvent, minutes: number): EventBody {
  const link = w.recordId ? recordUrl(w.recordId) : '';
  const description = [
    w.details,
    link ? `Dans le CRM : ${link}` : null,
    `Écrit par le bot Essort (${w.person}) : à modifier dans le CRM ou sur Discord, pas ici.`,
  ]
    .filter(Boolean)
    .join('\n');
  const extendedProperties = { private: { [KEY_PROPERTY]: w.key } };
  if (!w.time) {
    // Heure pas encore fixée : en attente dans le bandeau « toute la journée ».
    return {
      summary: `${w.label} · ${w.person} · heure à fixer`,
      description,
      start: { date: w.date },
      end: { date: addDays(w.date, 1) },
      extendedProperties,
    };
  }
  const start = startOf(w.date, w.time);
  return {
    summary: `${w.label} · ${w.person}`,
    description,
    start: { dateTime: new Date(start).toISOString(), timeZone: config.TIMEZONE },
    end: {
      dateTime: new Date(start + (w.minutes ?? minutes) * 60_000).toISOString(),
      timeZone: config.TIMEZONE,
    },
    extendedProperties,
  };
}

/** Un début ou une fin, comparable qu'il soit à l'heure ou à la journée. */
function slot(t: { dateTime?: string; date?: string } | undefined): string {
  if (t?.dateTime) return String(Date.parse(t.dateTime));
  return t?.date ?? '';
}

const PARIS_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Le jour (Paris, 'YYYY-MM-DD') où commence un événement. */
function dayOf(e: CalendarEvent): string | null {
  if (e.start?.dateTime) return PARIS_DAY.format(new Date(e.start.dateTime));
  return e.start?.date ?? null;
}

function sameEvent(e: CalendarEvent, b: EventBody): boolean {
  return (
    e.summary === b.summary &&
    (e.description ?? '') === (b.description ?? '') &&
    slot(e.start) === slot(b.start) &&
    slot(e.end) === slot(b.end)
  );
}

/**
 * Un rendez-vous écrit à la main avec le nom du lead dans le titre : au même
 * créneau à 15 min près, ou le même jour si l'heure n'est pas encore fixée.
 */
function writtenByHand(w: WantedEvent, others: CalendarEvent[]): boolean {
  const start = w.time ? startOf(w.date, w.time) : null;
  return others.some((e) => {
    if (start === null) {
      if (dayOf(e) !== w.date) return false;
    } else {
      const s = e.start?.dateTime ? Date.parse(e.start.dateTime) : NaN;
      if (!Number.isFinite(s) || Math.abs(s - start) > SAME_SLOT_MS) return false;
    }
    const title = significantWords(e.summary ?? '');
    return w.names.some((n) => title.includes(n));
  });
}

export interface CalendarChanges {
  create: EventBody[];
  update: { id: string; body: EventBody }[];
  remove: string[];
}

/**
 * Ce qu'il faut écrire pour que l'agenda montre `wanted`.
 * @param existing les événements de la fenêtre, tous auteurs confondus
 * @param today un événement du bot commencé avant ce jour reste tel quel
 */
export function planCalendar(
  wanted: WantedEvent[],
  existing: CalendarEvent[],
  minutes: number,
  today: string,
): CalendarChanges {
  const ours = new Map<string, CalendarEvent[]>();
  const others: CalendarEvent[] = [];
  for (const e of existing) {
    if (e.status === 'cancelled') continue;
    const key = e.extendedProperties?.private?.[KEY_PROPERTY];
    if (!key) others.push(e);
    else if ((dayOf(e) ?? '') >= today) ours.set(key, [...(ours.get(key) ?? []), e]);
  }

  const changes: CalendarChanges = { create: [], update: [], remove: [] };
  const seen = new Set<string>();
  for (const w of wanted) {
    if (seen.has(w.key)) continue;
    seen.add(w.key);
    const body = eventBody(w, minutes);
    // Deux écritures concurrentes ont pu créer deux fois le même événement.
    const [current, ...extra] = ours.get(w.key) ?? [];
    changes.remove.push(...extra.map((e) => e.id));
    if (writtenByHand(w, others)) {
      if (current) changes.remove.push(current.id);
    } else if (!current) {
      changes.create.push(body);
    } else if (!sameEvent(current, body)) {
      changes.update.push({ id: current.id, body });
    }
  }
  for (const [key, events] of ours) {
    if (!seen.has(key)) changes.remove.push(...events.map((e) => e.id));
  }
  return changes;
}

async function syncCalendar(agenda: Agenda, today: string): Promise<void> {
  const until = addDays(today, HORIZON_DAYS);
  const tasks = (
    await Promise.all(PEOPLE.map((p) => listPlannedTasks(p, today, addDays(until, -1))))
  ).flat();
  const recordIds = [
    ...new Set(PEOPLE.flatMap((p) => agenda.people[p].actions.map((a) => a.key.split('|')[0]!))),
  ];
  const handled = await listAirtableTasksFor(recordIds);
  const wanted = wantedEvents(agenda, tasks, handled, today, until);

  const existing = await listEvents(new Date(dayStart(today)), new Date(dayStart(until)));
  const changes = planCalendar(wanted, existing, config.ESSORT_EVENT_MINUTES, today);

  for (const id of changes.remove) await deleteEvent(id);
  for (const { id, body } of changes.update) await updateEvent(id, body);
  for (const body of changes.create) await insertEvent(body);

  const { create, update, remove } = changes;
  if (create.length + update.length + remove.length > 0) {
    logger.info(
      { created: create.length, updated: update.length, removed: remove.length },
      'agenda Google mis a jour',
    );
  }
}

// Une seule synchro à la fois ; une demande arrivée pendant ce temps repart
// juste après, avec la lecture du CRM la plus récente.
let running = false;
let next: { agenda: Agenda; today: string } | null = null;

/** Aligne l'agenda Google sur le CRM et le planning. Ne lève jamais d'erreur. */
export async function followInCalendar(agenda: Agenda, today: string): Promise<void> {
  if (!isCalendarConfigured()) return;
  next = { agenda, today };
  if (running) return;
  running = true;
  try {
    while (next) {
      const job = next;
      next = null;
      try {
        await syncCalendar(job.agenda, job.today);
      } catch (err) {
        logger.error({ err }, 'synchro agenda Google en echec');
      }
    }
  } finally {
    running = false;
  }
}
