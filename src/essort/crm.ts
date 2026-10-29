import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config, type EssortPerson } from '../config';
import { logger } from '../logger';
import {
  compareTime,
  daysBetween,
  duplicatesCrm,
  looksLikeMeeting,
  PEOPLE,
  significantWords,
  WEEK_DAYS,
  type Agenda,
  type CrmMatch,
  type CrmSpanSpec,
  type PersonAgenda,
} from './planner';

/**
 * Le CRM d'Essort (crm.essort.agency, espace « ESSORT · Leads du site ») : les
 * rendez-vous et les tâches que le bot pose sur les tableaux de Loys et d'Enzo.
 *
 * Deux routes, protégées par `CRM_SECRET` (la variable `PENSE_BETE_SECRET` du
 * projet Vercel essort-crm) :
 *  - `GET /api/pense-bete/agenda` : la lecture, dans une transaction `read only` ;
 *  - `/api/pense-bete/taches` : ce qu'on fait sur Discord aux TÂCHES du
 *    calendrier (ajouter, cocher, modifier, reporter, retirer) y est écrit
 *    (Loys, 29/10 : le calendrier du CRM et Discord, le même fonctionnement,
 *    dans les deux sens). Le calendrier est la seule source des tâches. Les
 *    prochaines actions des fiches, elles, ne s'écrivent que dans le CRM.
 *
 * Ce qui en sort :
 *  - la prochaine action de chaque fiche (`next_action_at`, `next_action_label`),
 *    sur le tableau de son responsable (dernier événement « assignation ») ;
 *  - les tâches du calendrier (table `taches`) sur le tableau de leur
 *    responsable : d'un jour, comme les actions ; sur plusieurs jours (période
 *    ou permanente), comme les tâches permanentes et périodes de Discord
 *    (`essort_spans`, reliées par `crm_ref`) ;
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
  /** Fin d'une période ; null pour une tâche d'un jour ou permanente. */
  fin_jour: z.string().regex(ISO_DATE).nullable().default(null),
  fin_heure: z.string().regex(HH_MM).nullable().default(null),
  permanente: z.boolean().default(false),
  /** Cochée dans le CRM (ou depuis Discord) : la route garde 7 jours les tâches faites. */
  fait: z.boolean().default(false),
});

const responseSchema = z.object({
  ok: z.literal(true),
  actions: z.array(actionSchema),
  taches: z.array(tacheSchema),
});

export type CrmLeadAction = z.infer<typeof actionSchema>;
export type CrmTache = z.input<typeof tacheSchema>;
export type CrmData = { actions: CrmLeadAction[]; taches: CrmTache[] };

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

/** Une tâche telle que Discord l'écrit dans le calendrier du CRM (heure de Paris). */
export interface CrmTacheEcrite {
  titre: string;
  jour: string;
  /** null : toute la journée. */
  heure: string | null;
  /** null : pour les deux. */
  responsable: string | null;
  fin_jour?: string | null;
  fin_heure?: string | null;
  permanente?: boolean;
}

/** Ce qu'on dit sur Discord quand le CRM n'a pas pu enregistrer : rien n'a changé. */
export const CRM_INJOIGNABLE =
  'Le CRM n’a pas répondu : rien n’est changé, ni ici ni dans le calendrier. Réessaie dans un instant.';

async function ecrire(
  method: 'POST' | 'PATCH' | 'DELETE',
  body: Record<string, unknown>,
): Promise<{ id: string } | null> {
  const secret = config.CRM_SECRET;
  if (!secret) throw new Error(CRM_INJOIGNABLE);
  let res: Response;
  try {
    res = await fetch(`${config.CRM_URL.replace(/\/+$/, '')}/api/pense-bete/taches`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    logger.warn({ err, method }, 'ecriture CRM impossible');
    throw new Error(CRM_INJOIGNABLE);
  }
  // Déjà supprimée dans le CRM : il n'y a plus rien à y faire.
  if (res.status === 404) return null;
  if (!res.ok) {
    logger.warn(
      { status: res.status, body: (await res.text()).slice(0, 200), method },
      'ecriture CRM refusee',
    );
    throw new Error(CRM_INJOIGNABLE);
  }
  return (await res.json()) as { id: string };
}

/**
 * Les tâches du calendrier du CRM, écrites depuis Discord. Chaque appel lève
 * `CRM_INJOIGNABLE` en cas d'échec : l'appelant n'a alors rien changé de son
 * côté, et la personne voit l'erreur.
 */
export const crmTaches = {
  async creer(t: CrmTacheEcrite): Promise<string> {
    const res = await ecrire('POST', { ...t });
    if (!res) throw new Error(CRM_INJOIGNABLE);
    return res.id;
  },
  /** Faux si la tâche n'existe plus dans le CRM. */
  async modifier(
    id: string,
    patch: Partial<CrmTacheEcrite> & { fait?: boolean },
  ): Promise<boolean> {
    return (await ecrire('PATCH', { id, ...patch })) !== null;
  },
  async supprimer(id: string): Promise<void> {
    await ecrire('DELETE', { id });
  },
};

/** L'identifiant de la tâche du CRM derrière une tâche du tableau, ou null (action d'une fiche, tâche d'avant). */
export function crmTacheId(recordId: string | null | undefined): string | null {
  const base = recordId?.split('@')[0] ?? '';
  return base.startsWith(TACHE) ? base.slice(TACHE.length) : null;
}

/** L'identifiant d'une tâche du CRM, sur le tableau. */
export function tacheRecordId(id: string): string {
  return `${TACHE}${id}`;
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
  /** Le cabinet, la note, le téléphone s'il faut appeler. */
  details: string[];
  signature: string;
  match: CrmMatch;
  heat: number;
  minutes?: number;
  /** Une tâche du calendrier : cochée ou non dans le CRM. Absent pour une action de fiche. */
  done?: boolean;
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
    done: t.fait ?? false,
  };
}

/** Une période ou une tâche permanente : elle vit sur Discord comme celles qu'on y crée. */
function surPlusieursJours(t: CrmTache): boolean {
  return Boolean(t.permanente || t.fin_jour);
}

/**
 * Les tâches du calendrier sur plusieurs jours, telles que les tâches
 * permanentes et périodes de Discord (`essort_spans`) doivent les montrer.
 * Sans responsable, ou les deux prénoms cités : pour toute l'équipe.
 */
export function crmSpanSpecs(crm: CrmData): CrmSpanSpec[] {
  return crm.taches.filter(surPlusieursJours).map((t) => ({
    ref: t.id,
    kind: t.permanente ? ('permanent' as const) : ('period' as const),
    label: withLead(t.titre, t.lead_nom, t.lead_nom ? significantWords(t.lead_nom) : []),
    people: peopleFor(t.responsable, t.titre),
    start_date: t.jour,
    start_time: t.heure,
    end_date: t.permanente ? null : (t.fin_jour ?? null),
    end_time: t.permanente ? null : (t.fin_heure ?? null),
    done: t.fait ?? false,
  }));
}

/**
 * L'agenda de chaque personne : prévu aujourd'hui = tâche du jour ; dans les
 * 6 jours suivants = planning de la semaine ; tout, quelle que soit la date,
 * dans `actions` (pour dire ce qui a changé dans le CRM).
 *
 * Une action dont la date est passée n'est JAMAIS remise sur le tableau du
 * jour (Loys, 29/10 : au passage au CRM, toutes les fiches à la prochaine
 * action périmée étaient arrivées d'un coup). On la redate dans le CRM, ou on
 * la reporte le soir sur Discord.
 *
 * Les tâches du calendrier d'un jour s'y ajoutent, cochées si elles le sont
 * dans le CRM ; une telle tâche l'emporte sur l'action d'une fiche qui dit la
 * même chose le même jour (comme une tâche écrite à la main sur Discord). Les
 * tâches sur plusieurs jours n'y sont pas : elles vont dans `spans`.
 */
export function buildCrmAgenda(crm: CrmData, today: string, weekDays = WEEK_DAYS): Agenda {
  const people = Object.fromEntries(
    PEOPLE.map((p) => [p, { due: [], upcoming: [], actions: [] } as PersonAgenda]),
  ) as Record<EssortPerson, PersonAgenda>;
  const heats = new Map<string, number>();

  const taches = crm.taches.filter((t) => !surPlusieursJours(t)).map(tacheItem);
  /** L'action d'une fiche qu'une tâche du même jour, chez la même personne, dit déjà. */
  const ditDeja = (item: CrmItem, person: EssortPerson): boolean =>
    taches.some(
      (t) =>
        t.date === item.date &&
        t.people.includes(person) &&
        duplicatesCrm({ label: t.label, time: t.time }, item),
    );

  for (const item of [...crm.actions.map(actionItem), ...taches]) {
    // Juste ce qu'il faut pour agir : le cabinet, la note, le téléphone s'il faut appeler.
    const details = item.details.join(' · ');
    for (const person of item.people) {
      if (item.done === undefined && ditDeja(item, person)) continue;
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
      if (delta === 0) {
        agenda.due.push({
          recordId,
          signature: item.signature,
          label: item.label,
          details,
          dueDate: item.date,
          time: item.time,
          match: item.match,
          ...(item.done !== undefined ? { done: item.done } : {}),
        });
        heats.set(recordId, item.heat);
      } else if (delta > 0 && delta <= weekDays && !item.done) {
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
    // Par heure, puis les leads chauds.
    agenda.due.sort(
      (a, b) =>
        compareTime(a.time, b.time) || (heats.get(a.recordId) ?? 3) - (heats.get(b.recordId) ?? 3),
    );
    agenda.upcoming.sort((a, b) => a.date.localeCompare(b.date) || compareTime(a.time, b.time));
    agenda.actions.sort((a, b) => a.date.localeCompare(b.date) || compareTime(a.time, b.time));
  }

  return { people, spans: crmSpanSpecs(crm) };
}
