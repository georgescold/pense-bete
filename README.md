# Pense-bête bot Discord

Bot Discord personnel de rappels (pense-bête), avec rappels ponctuels et récurrents, parsing français des dates, persistance Supabase, déploiement Railway.

## Stack

- Node.js 20 + TypeScript (strict)
- discord.js v14 (slash commands)
- @supabase/supabase-js (persistance)
- node-cron + cron-parser (planification)
- chrono-node (fallback parsing FR)
- pino (logs)
- Zod (validation)

## Setup Discord

1. Créer une application sur [Discord Developer Portal](https://discord.com/developers/applications).
2. Onglet **Bot** → copier le **token**.
3. Onglet **OAuth2 → URL Generator** → scopes : `bot`, `applications.commands` → permissions : `Send Messages`, `Embed Links`, `Mention Everyone`, `Read Message History`.
4. Inviter le bot via l'URL générée.

## Setup Supabase

1. Créer un projet Supabase (ou réutiliser un existant).
2. Appliquer la migration : **SQL Editor → New query**, coller le contenu de `supabase/migrations/00000000000000_init_reminders.sql`, **Run**.
3. **Settings → API** :
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** (⚠️ pas l'anon/publishable key) → `SUPABASE_SERVICE_ROLE_KEY`
4. (Optionnel) Régénérer les types : `npx supabase gen types typescript --project-id <ref> --schema public > src/db/types.gen.ts`.

> Pour ce projet : URL = `https://vfbxdgyyqcsvpjgzwsus.supabase.co`. Récupérer la service_role key dans le dashboard.

## Dev local

```bash
cp .env.example .env
# remplir DISCORD_TOKEN, CLIENT_ID, GUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm install
npm run deploy-commands   # à lancer une fois pour enregistrer les slash commands
npm run dev               # tsx watch
```

## Déploiement Railway

1. Push sur GitHub.
2. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub** → sélectionner le repo.
3. **Variables** → ajouter toutes les vars du `.env.example`.
4. Aucun volume nécessaire (toute la persistance est dans Supabase).
5. Les déploiements sont auto à chaque push sur `main`.

## Variables d'environnement

| Var | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token (Developer Portal) |
| `CLIENT_ID` | Application ID Discord |
| `GUILD_ID` | (optionnel) Pour deploy commands en guild — instantané au lieu de ~1h |
| `SUPABASE_URL` | URL du projet Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (bypass RLS) |
| `TIMEZONE` | par défaut `Europe/Paris` |
| `LOG_LEVEL` | par défaut `info` |

## Commandes

| Commande | Description |
|---|---|
| `/rappel ajouter texte:<…> quand:<…>` | Crée un rappel |
| `/rappel liste` | Liste vos rappels |
| `/rappel supprimer id:<…>` | Supprime |
| `/rappel pause id:<…>` | Met en pause |
| `/rappel reprendre id:<…>` | Reprend |

### Exemples d'expressions reconnues

- `dans 2h`, `dans 30 minutes`, `dans 3 jours`
- `demain 9h`, `vendredi 14h`, `le 25 décembre à 10h`
- `tous les jours à 7h`
- `tous les lundis à 8h`
- `tous les lundis et jeudis à 9h`
- `tous les 15 du mois à 9h`
- `le dernier jour du mois à 18h`
- `toutes les 30 minutes`, `toutes les 2 heures`

## Tests

```bash
npm test
```

Le parser français est couvert par 21+ tests (`src/scheduler/parser.test.ts`).

## Architecture

```
src/
├── index.ts              # Entry point: connexion Discord + rechargement rappels + handlers
├── config.ts             # Validation env vars (Zod)
├── logger.ts             # Pino
├── commands/
│   ├── index.ts
│   ├── rappel.ts         # /rappel ajouter|liste|supprimer|pause|reprendre
│   └── types.ts
├── scheduler/
│   ├── parser.ts         # Parsing FR → cron / Date
│   ├── parser.test.ts
│   ├── scheduler.ts      # Map<id, job> + node-cron + long-timeout
│   └── trigger.ts        # Envoi du rappel + update next_run_at
├── db/
│   ├── supabase.ts       # Client Supabase
│   └── repository.ts     # CRUD typé
├── lib/
│   ├── embeds.ts         # Builders Discord embeds
│   └── format.ts         # Format date FR
└── scripts/
    └── deploy-commands.ts
```
