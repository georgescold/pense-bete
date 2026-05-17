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
});

export type AppConfig = z.infer<typeof schema>;

export const config: AppConfig = schema.parse(process.env);
