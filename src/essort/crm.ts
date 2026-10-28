import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config, type EssortPerson } from '../config';
import {
  compareTime,
  daysBetween,
  looksLikeMeeting,
  PEOPLE,
  shortDate,
  significantWords,
  WEEK_DAYS,
  type Agenda,
  type CrmMatch,
  type PersonAgenda,
} from './planner';

/**
 * Lecture du CRM d'Essort (crm.essort.agency, espace « ESSORT · Leads du
 * site ») : les rendez-vous et les tâches que le bot pose sur les tableaux de
 * Loys et d'Enzo.
 *
 * ⚠️ LECTURE SEULE. Le bot n'appelle qu'une route, en GET :
 * `/api/pense-bete/agenda`, protégée par `CRM_SECRET` (la variable
 * `PENSE_BETE_SECRET` du projet Vercel essort-crm), qui lit la base dans une
 * transaction `read only`. Le suivi des tâches faites vit dans Supabase et le
 * Google Sheet, jamais dans le CRM.
 *
 * Ce qui en sort :
 *  - la prochaine action de chaque fiche (`next_action_at`, `next_action_label`),
 *    sur le tableau de son responsable (dernier événement « assignation ») ;
 *  - les tâches du calendrier pas encore faites (table `taches`), sur le
 *    tableau de leur responsable ;
 *  - sans responsable : le seul prénom de l'équipe cité dans le texte
 *    (« R1 · Enzo appelle Lucie »), sinon les deux tableaux ;
 *  - une heure à minuit, ou une tâche « toute la journée » : un jour sans heure.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^\d{2}:\d{2}$/;

const actionSchema = z.object({
  id: z.string(),
  nom: z.string(),
  cabinet: z.string().nullable(),
  telephone: z.string().nullable(),
  statut: z.string(),
  verdict: z.string().nullable(),
  libelle: z.string().nullable(),
  jour: z.string().regex(ISO_DATE),
  heure: z.string().regex(HH_MM).nullable(),
  responsable: z.string().nullable(),
});

const tacheSchema = z.object({
  id: z.string(),
  titre: z.string(),
  note: z.string().nullable(),
  jour: z.string().regex(ISO_DATE),
  heure: z.string().regex(HH_MM).nullable(),
  duree_minutes: z.number().int().positive(),
  responsable: z.string().nullable(),
  lead_id: z.string().nullable(),
  lead_nom: z.string().nullable(),
  lead_cabinet: z.string().nullable(),
  lead_telephone: z.string().nullable(),
});

const responseSchema = z.object({
  ok: z.literal(true),
  actions: z.array(actionSchema),
  taches: z.array(tacheSchema),
});

export type CrmLeadAction = z.infer<typeof actionSchema>;
export type CrmTache = z.infer<typeof tacheSchema>;
export type CrmData = Omit<z.infer<typeof responseSchema>, 'ok'>;

/** Les rendez-vous et les tâches de l'espace ESSORT. */
export async function fetchCrm(): Promise<CrmData> {
  const secret = config.CRM_SECRET;
  if (!secret) throw new Error('CRM_SECRET absent');
  const res = await fetch(`${config.CRM_URL.replace(/\/+$/, '')}/api/pense-bete/agenda`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CRM ${res.status}: ${body.slice(0, 200)}`);
  }
  const { actions, taches } = responseSchema.parse(await res.json());
  return { actions, taches };
}

// ---------------------------------------------------------------------------
// Identifiants : « lead:<fiche> » ou « tache:<tâche> », suivis de « @loys » ou
// « @enzo » quand la même chose est posée sur les deux tableaux (chacun la
// coche, la retire ou la reporte de son côté).
// ---------------------------------------------------------------------------

const LEAD = 'lead:';
const TACHE = 'tache:';

/** La fiche du lead, ou la tâche dans le calendrier du CRM ; '' pour un ancien identifiant Airtable. */
export function recordUrl(recordId: string): string {
  const base = recordId.split('@')[0] ?? '';
  const crm = config.CRM_URL.replace(/\/+$/, '');
  if (base.startsWith(LEAD)) return `${crm}/leads/${base.slice(LEAD.length)}`;
  if (base.startsWith(TACHE)) return `${crm}/calendrier?tache=${base.slice(TACHE.length)}`;
  return '';
}

// ---------------------------------------------------------------------------
// Du CRM à l'agenda de chaque personne (fonctions pures)
// ---------------------------------------------------------------------------

/** Titre d'une action sans libellé : il dépend de l'étape, comme dans le calendrier du CRM. */
export function defaultTitle(statut: string): string {
  if (statut === 'rdv') return 'Rendez-vous';
  if (statut === 'r1') return 'R1';
  if (statut === 'r2') return 'R2';
  if (statut === 'attente_reponse' || statut === 'a_relancer') return 'Relance';
  if (statut === 'nouveau') return 'Premier appel';
  return 'Rappel';
}

/**
 * Le tableau de la personne : le responsable (Loys ou Enzo) ; sans
 * responsable, le seul prénom de l'équipe cité dans le texte, sinon les deux.
 * Un autre prénom : personne (ce n'est pas l'un de nos tableaux).
 */
export function peopleFor(responsable: string | null, text: string): EssortPerson[] {
  const r = responsable?.trim().toLowerCase();
  if (r) {
    const person = PEOPLE.find((p) => p.toLowerCase() === r);
    return person ? [person] : [];
  }
  const plain = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const named = PEOPLE.filter((p) => new RegExp(`\\b${p.toLowerCase()}\\b`).test(plain));
  return named.length === 1 ? named : [...PEOPLE];
}

/**
 * Identifie « cette » action : une fois validée, elle ne revient pas tant que
 * le CRM ne change ni son libellé ni sa date. Le libellé n'y entre que par
 * une empreinte courte : la clé `<id>|<signature>` sert de valeur dans les
 * menus Discord, limitée à 100 caractères, et un libellé du CRM est libre.
 */
export function signatureOf(text: string, date: string): string {
  const action = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return `${createHash('sha1').update(action).digest('hex').slice(0, 10)}|${date}`;
}

/** Le texte cite-t-il déjà le lead (prénom, nom, cabinet) ? */
function mentions(text: string, names: string[]): boolean {
  const plain = significantWords(text);
  return names.some((n) => plain.includes(n));
}

/** « Appel » devient « Appel · Camille Dubreuil » ; « R1 · Enzo appelle Lucie » reste tel quel. */
function withLead(text: string, nom: string | null, names: string[]): string {
  if (!nom || mentions(text, names)) return text;
  return `${text} · ${nom}`;
}

const CALL_WORDS = /appel|rappel|relanc|t[eé]l[eé]phon|whatsapp|\bsms\b|\bcall\b|\br\s?[12]\b/i;

/** Le téléphone ne sert que s'il faut appeler, et s'il n'est pas déjà écrit dans le texte. */
function phoneFor(text: string, phone: string | null): string | null {
  if (!phone || !CALL_WORDS.test(text)) return null;
  const digits = phone.replace(/\D/g, '').slice(-8);
  if (digits && text.replace(/\D/g, '').includes(digits)) return null;
  return `☎ ${phone}`;
}

function truncateText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Les leads chauds d'abord à heure égale. */
function heat(verdict: string | null): number {
  if (verdict === 'chaud') return 0;
  if (verdict === 'tiede') return 1;
  if (verdict === 'froid') return 2;
  return 3;
}

/** Une chose à faire lue dans le CRM, avant d'être posée sur un ou deux tableaux. */
interface CrmItem {
  recordId: string;
  people: EssortPerson[];
  date: string;
  time: string | null;
  label: string;
  /** Sans le retard, ajouté au moment de poser la tâche. */
  details: string[];
  signature: string;
  match: CrmMatch;
  heat: number;
  minutes?: number;
}

function actionItem(a: CrmLeadAction): CrmItem {
  const action = a.libelle ?? defaultTitle(a.statut);
  const names = significantWords(`${a.nom} ${a.cabinet ?? ''}`);
  const label = withLead(action, a.nom, names);
  const cabinet =
    a.cabinet &&
    a.cabinet.toLowerCase() !== a.nom.toLowerCase() &&
    !mentions(label, significantWords(a.cabinet))
      ? a.cabinet
      : null;
  return {
    recordId: `${LEAD}${a.id}`,
    people: peopleFor(a.responsable, action),
    date: a.jour,
    time: a.heure,
    label,
    details: [cabinet, phoneFor(action, a.telephone)].filter((d): d is string => Boolean(d)),
    signature: signatureOf(action, a.jour),
    match: {
      names,
      meeting: a.libelle ? looksLikeMeeting(a.libelle) : ['rdv', 'r1', 'r2'].includes(a.statut),
      prep: false,
    },
    heat: heat(a.verdict),
  };
}

function tacheItem(t: CrmTache): CrmItem {
  // Rattachée à un lead : on la reconnaît à son nom ; sinon, aux mots de son titre.
  const names = t.lead_nom
    ? significantWords(`${t.lead_nom} ${t.lead_cabinet ?? ''}`)
    : significantWords(t.titre);
  const label = withLead(t.titre, t.lead_nom, names);
  const text = `${t.titre} ${t.note ?? ''}`;
  return {
    recordId: `${TACHE}${t.id}`,
    people: peopleFor(t.responsable, t.titre),
    date: t.jour,
    time: t.heure,
    label,
    details: [t.note ? truncateText(t.note, 120) : null, phoneFor(text, t.lead_telephone)].filter(
      (d): d is string => Boolean(d),
    ),
    signature: signatureOf(t.titre, t.jour),
    match: { names, meeting: looksLikeMeeting(t.titre), prep: false },
    heat: 3,
    minutes: t.duree_minutes,
  };
}

/** Juste ce qu'il faut pour agir : le cabinet, la note, le téléphone s'il faut appeler, un retard. */
function detailsOf(item: CrmItem, today: string): string {
  const parts = [...item.details];
  if (daysBetween(item.date, today) > 0) {
    const at = item.time ? ` à ${item.time}` : '';
    parts.push(`en retard, prévu le ${shortDate(item.date)}${at}`);
  }
  return parts.join(' · ');
}

/**
 * L'agenda de chaque personne, comme le lisait l'ancienne version depuis
 * Airtable : échu (date ≤ aujourd'hui, retards compris) = tâche du jour ;
 * dans les 6 jours suivants = planning de la semaine ; tout, quelle que soit
 * la date, dans `actions` (pour dire ce qui a changé dans le CRM).
 *
 * Une action en retard arrive sur le jour SANS heure : l'heure d'un jour passé
 * ne vaut plus aujourd'hui, elle sonnerait pour rien (le détail la rappelle).
 */
export function buildCrmAgenda(crm: CrmData, today: string, weekDays = WEEK_DAYS): Agenda {
  const people = Object.fromEntries(
    PEOPLE.map((p) => [p, { due: [], upcoming: [], actions: [] } as PersonAgenda]),
  ) as Record<EssortPerson, PersonAgenda>;
  const heats = new Map<string, number>();

  for (const item of [...crm.actions.map(actionItem), ...crm.taches.map(tacheItem)]) {
    const details = detailsOf(item, today);
    for (const person of item.people) {
      const recordId =
        item.people.length > 1 ? `${item.recordId}@${person.toLowerCase()}` : item.recordId;
      const key = `${recordId}|${item.signature}`;
      const agenda = people[person];
      agenda.actions.push({
        key,
        date: item.date,
        time: item.time,
        label: item.label,
        match: item.match,
        details,
        ...(item.minutes ? { minutes: item.minutes } : {}),
      });
      const delta = daysBetween(today, item.date);
      if (delta <= 0) {
        agenda.due.push({
          recordId,
          signature: item.signature,
          label: item.label,
          details,
          dueDate: item.date,
          time: delta < 0 ? null : item.time,
          match: item.match,
        });
        heats.set(recordId, item.heat);
      } else if (delta <= weekDays) {
        agenda.upcoming.push({
          key,
          date: item.date,
          time: item.time,
          label: item.label,
          match: item.match,
          details,
        });
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
