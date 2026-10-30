import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(10, 'DISCORD_TOKEN manquant'),
  CLIENT_ID: z.string().min(5, 'CLIENT_ID manquant'),
  GUILD_ID: z.string().optional(),
  SUPABASE_URL: z.string().url('SUPABASE_URL invalide'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10, 'SUPABASE_SERVICE_ROLE_KEY manquant'),
  TIMEZONE: z.string().default('Europe/Paris'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- Journées de travail (préparation 18h / checklist 7h) ---
  // La fonctionnalité ne s'active que si le salon ET l'utilisateur sont définis.
  DAILY_CHANNEL_ID: z.string().optional(),
  DAILY_USER_ID: z.string().optional(),
  DAILY_PREP_CRON: z.string().default('0 18 * * *'),
  DAILY_BOARD_CRON: z.string().default('0 7 * * *'),
  // En veille par défaut : ni préparation de 18h, ni checklist de 7h, ni /journee.
  // Mettre DAILY_PAUSED=false pour relancer.
  DAILY_PAUSED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // --- Archivage Google Sheets (optionnel) ---
  // Une clé API ne peut PAS écrire dans un Sheet : il faut un compte de service.
  GOOGLE_SHEET_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // --- Essort : rendez-vous et tâches lus dans le CRM (crm.essort.agency) ---
  // Le bot ne fait que LIRE le CRM, par une seule route (GET
  // /api/pense-bete/agenda) protégée par ce secret (PENSE_BETE_SECRET chez Vercel).
  CRM_URL: z.string().url().default('https://crm.essort.agency'),
  CRM_SECRET: z.string().optional(),
  // Ancienne source (Airtable, table « Leads ») : plus lue depuis le 28/10/2026.
  // `essort/airtable.ts` reste en place tant que Loys n'a pas accepté de le retirer.
  AIRTABLE_TOKEN: z.string().optional(),
  AIRTABLE_BASE_ID: z.string().default('appWdzyvFb3DaqPXk'),
  AIRTABLE_LEADS_TABLE: z.string().default('tblcpyeIaC9qJPOnJ'),
  ESSORT_CRON: z.string().default('0 6 * * *'),
  // Synchro avec le CRM : relu toutes les 5 minutes ; un changement met à jour
  // les messages du jour (sans mention) et le bot dit en une ligne ce qu'il a
  // compris. Une tâche posée en base par une autre voie suit au même rythme.
  ESSORT_SYNC_CRON: z.string().default('*/5 * * * *'),
  // En fin de journée, chaque personne qui a encore des tâches du jour à faire
  // est mentionnée dans son salon, une fois (Loys, 30/10).
  ESSORT_NUDGE_CRON: z.string().default('0 18 * * *'),
  // Le soir, le bot demande quelles tâches non faites passer au lendemain.
  // Rien n'est jamais reporté sans réponse.
  ESSORT_EVENING_CRON: z.string().default('0 19 * * *'),
  // Une tâche sur une période : à sa fin, le bot demande si elle a pu être
  // faite (faite, reportée ou abandonnée). Vérifié toutes les minutes.
  ESSORT_SPAN_CRON: z.string().default('* * * * *'),
  // Une personne n'a de tableau que si son salon est défini. L'identifiant
  // Discord sert à la mentionner et à limiter qui peut cocher.
  ESSORT_LOYS_CHANNEL_ID: z.string().optional(),
  ESSORT_LOYS_USER_ID: z.string().optional(),
  ESSORT_ENZO_CHANNEL_ID: z.string().optional(),
  ESSORT_ENZO_USER_ID: z.string().optional(),

  // --- Essort : l'agenda Google suit les rendez-vous à heure fixe ---
  // ID de l'agenda (pour l'agenda principal d'un compte : son adresse). Vide :
  // le bot n'écrit dans aucun agenda.
  GOOGLE_CALENDAR_ID: z.string().optional(),
  // Clé JSON (brute ou base64) du compte de service avec qui l'agenda est
  // partagé (« Apporter des modifications aux événements ») ; à défaut, celle
  // du Sheet.
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON: z.string().optional(),
  // Durée d'un rendez-vous dans l'agenda, en minutes.
  ESSORT_EVENT_MINUTES: z.coerce.number().int().min(5).max(480).default(60),
});

export type AppConfig = z.infer<typeof schema>;

// Trim whitespace/newlines that Railway/Docker sometimes inject around long secrets
const cleaned: Record<string, string | undefined> = {};
for (const key of Object.keys(schema.shape)) {
  const v = process.env[key];
  cleaned[key] = typeof v === 'string' ? v.trim() : v;
}

export const config: AppConfig = schema.parse(cleaned);

/** Salon + utilisateur définis : la fonctionnalité est utilisable. */
export const dailyConfigured = Boolean(config.DAILY_CHANNEL_ID && config.DAILY_USER_ID);

/** Les journées de travail ne tournent que si elles sont configurées et pas en veille. */
export const dailyEnabled = dailyConfigured && !config.DAILY_PAUSED;

/** Les responsables possibles d'une fiche ou d'une tâche du CRM : une personne = un tableau. */
export type EssortPerson = 'Loys' | 'Enzo';

export interface EssortMember {
  person: EssortPerson;
  channelId: string;
  userId: string | null;
}

export const essortMembers: EssortMember[] = (
  [
    ['Loys', config.ESSORT_LOYS_CHANNEL_ID, config.ESSORT_LOYS_USER_ID],
    ['Enzo', config.ESSORT_ENZO_CHANNEL_ID, config.ESSORT_ENZO_USER_ID],
  ] as const
)
  .filter(([, channelId]) => Boolean(channelId))
  .map(([person, channelId, userId]) => ({
    person,
    channelId: channelId as string,
    userId: userId ?? null,
  }));

/** Tableaux Essort : le secret du CRM et au moins un salon. */
export const essortEnabled = Boolean(config.CRM_SECRET) && essortMembers.length > 0;

// Diagnostic log on boot: confirm injected values are well-formed (no secret leak).
const sk = config.SUPABASE_SERVICE_ROLE_KEY;
const dots = (sk.match(/\./g) || []).length;
// eslint-disable-next-line no-console
console.log(
  `[config] SUPABASE_SERVICE_ROLE_KEY len=${sk.length} dots=${dots} prefix=${sk.slice(0, 6)} suffix=${sk.slice(-6)}`,
);
// eslint-disable-next-line no-console
console.log(`[config] SUPABASE_URL=${config.SUPABASE_URL}`);
// eslint-disable-next-line no-console
console.log(
  `[config] journées=${
    dailyEnabled ? 'activées' : config.DAILY_PAUSED ? 'en veille' : 'désactivées'
  } sheets=${config.GOOGLE_SERVICE_ACCOUNT_JSON ? 'compte de service' : 'non configuré'} essort=${
    essortEnabled
      ? essortMembers.map((m) => m.person).join('+')
      : config.CRM_SECRET
        ? 'aucun salon'
        : 'pas de secret du CRM'
  } agenda=${config.GOOGLE_CALENDAR_ID ? config.GOOGLE_CALENDAR_ID : 'non configuré'}`,
);
