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
  } sheets=${
    config.GOOGLE_SERVICE_ACCOUNT_JSON ? 'compte de service' : 'non configuré'
  }`,
);
