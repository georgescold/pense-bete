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
3. Onglet **OAuth2 → URL Generator** → scopes : `bot`, `applications.commands` → permissions : `Send Messages`, `Embed Links`, `Mention Everyone`, `Read Message History`, **`Manage Messages`** (nécessaire pour **épingler** les rappels).
4. Inviter le bot via l'URL générée.

> Aucun intent privilégié requis : mentionner le bot suffit à recevoir le message (Discord fournit le contenu des messages qui mentionnent le bot). L'intent `GuildMessages` (non privilégié) est activé côté code.

## Setup Supabase

1. Créer un projet Supabase (ou réutiliser un existant).
2. Appliquer la migration : **SQL Editor → New query**, coller le contenu de `supabase/migrations/00000000000000_init_reminders.sql`, **Run**.
3. **Settings → API** :
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** (⚠️ pas l'anon/publishable key) → `SUPABASE_SERVICE_ROLE_KEY`
4. (Optionnel) Régénérer les types : `npx supabase gen types typescript --project-id <ref> --schema public > src/db/types.gen.ts`.

> Pour ce projet, projet Supabase "Pense bête" : URL = `https://cfmhhqgttjyfitiweslh.supabase.co`. La service_role key est dans le dashboard (Settings → API).

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
| `AIRTABLE_TOKEN` | (Essort) token Airtable en **lecture seule** (`data.records:read`) |
| `AIRTABLE_BASE_ID` / `AIRTABLE_LEADS_TABLE` | (Essort) par défaut la base et la table « Leads » d'Essort |
| `ESSORT_CRON` | (Essort) par défaut `0 6 * * *` (6h, heure de Paris) |
| `ESSORT_REFRESH_CRON` | (Essort) relectures d'Airtable, par défaut `0 12,17 * * *` (12h et 17h) |
| `ESSORT_LOYS_CHANNEL_ID` / `ESSORT_ENZO_CHANNEL_ID` | (Essort) salon de chaque tableau ; sans salon, pas de tableau |
| `ESSORT_LOYS_USER_ID` / `ESSORT_ENZO_USER_ID` | (Essort) pour mentionner la personne et réserver les boutons à l'équipe |

## Commandes

| Commande | Description |
|---|---|
| `/rappel ajouter` | Ouvre le formulaire interactif pour créer un rappel |
| `/rappel liste` | Liste vos rappels |
| `/rappel recap` | Récap clair de tous vos rappels planifiés |
| `/rappel calendrier` | Vue calendrier des rappels à venir |
| `/rappel supprimer id:<…>` | Supprime |
| `/rappel pause id:<…>` | Met en pause |
| `/rappel reprendre id:<…>` | Reprend |
| **@mention du bot** | Affiche l'aide (toutes les commandes) |

## Salon & épinglage

- Un rappel se déclenche **dans le salon où il a été créé** (le `channel_id` est mémorisé).
- À la création, le **récap est épinglé** dans le salon tant que le rappel est actif.
  Il est **dés-épinglé** automatiquement au clic sur **✅ Fait** ou via `/rappel supprimer`.
  (Nécessite la permission *Gérer les messages*.)
- **Mentionner le bot** (`@Pense-bête`) renvoie l'aide complète.

## Formulaire guidé (`/rappel ajouter`)

Tout se fait **par menus**, sans saisie de date à la main. On choisit d'abord le
**type**, puis on enchaîne directement sur le **jour/date** et l'**heure** :

1. **Type** : 📅 *Ponctuel (une fois)* ou 🔁 *Récurrent (régulier)* → passe aussitôt à l'étape suivante.
2. **Quand** (2 petits écrans) :
   - **Ponctuel** → *écran 1 : jour* (mois en deux moitiés 1–15 / 16–fin sur ~12 mois → jour),
     *écran 2 : heure* (heure + minutes **dizaines** + **unités**, au pas de 1).
   - **Récurrent** → *écran 1 : fréquence* (tous les jours, chaque semaine avec choix des jours,
     jours ouvrés, week-end, chaque mois avec choix du jour, dernier jour du mois),
     *écran 2 : heure* (idem, minutes au pas de 1).
3. **Texte**, **destinataire**, **couleur**, **relance** (ponctuel), puis **✅ Créer**.

> Minutes au pas de 1 via deux menus (dizaines 00–50 + unités 0–9), car un menu Discord
> est limité à 25 options (60 minutes n'y tiennent pas). L'heure finale s'affiche en aperçu.
> Plus aucun champ texte libre pour la date.

## Relance ("réveil") — rappels non validés

Chaque rappel **ponctuel** relance automatiquement tant que tu n'as pas cliqué
**✅ Fait**, selon l'échelle : **4 h → 6 h → 1 j → 3 j → 1 semaine**, puis **chaque
semaine** indéfiniment. Sur chaque message de rappel :

- **✅ Fait** — valide et arrête définitivement les relances.
- **😴 Reporter** — repousse à un moment choisi (30 min, 1 h, 3 h, ce soir, demain 9 h, 1 semaine) et repart de zéro dans l'échelle.
- **✏️ Redéfinir** — replanifie le rappel à un nouveau jour/heure (cascade).

La relance est **activée par défaut** ; un bouton **🔔 Relance : ON/OFF** dans le
formulaire permet de la désactiver par rappel. Les rappels récurrents ne sont pas
concernés (ils se redéclenchent d'eux-mêmes).

### Exemples d'expressions reconnues

- `dans 2h`, `dans 30 minutes`, `dans 3 jours`
- `demain 9h`, `vendredi 14h`, `le 25 décembre à 10h`
- `tous les jours à 7h`
- `tous les lundis à 8h`
- `tous les lundis et jeudis à 9h`
- `tous les 15 du mois à 9h`
- `le dernier jour du mois à 18h`
- `toutes les 30 minutes`, `toutes les 2 heures`

## Essort : tâches commerciales du CRM Airtable

Chaque jour à 6h, le bot lit la table « Leads » d'Airtable (**sans jamais y écrire**) et
poste un tableau dans le salon de chaque personne (champ **Gestion** : Loys ou Enzo). Il relit
Airtable à 12h et 17h et met le même message à jour, sans nouvelle mention.

- **Tâche du jour** : lead dont la *date de la prochaine action* est aujourd'hui ou passée
  (retard affiché). Sans date, la date est lue dans *Prochain événement* (« jeudi 08/10 »,
  « fin octobre »…). Le libellé dépend de l'*Action* (a call, R1, R2, à relancer…). Les leads
  `dead` sont ignorés.
- **À venir** (3 jours), **sans date de prochaine action**, **sans responsable** : affichés
  sous la liste, pour préparer et compléter Airtable.
- **✔️** valide une tâche : elle part aussitôt dans l'onglet « Essort » du Google Sheet
  (décocher efface la ligne). Une action validée ne revient pas tant que sa date ou son
  action n'ont pas changé dans Airtable : elle est alors signalée « date à changer ».
- Une tâche non faite **reste affichée** les jours suivants, jusqu'à être faite ou retirée.
- **➕** ajoute une tâche à la main, **🗑️** retire n'importe quelle tâche du tableau (une tâche
  Airtable retirée ne revient pas tant que le lead ne change pas), **🔄** relit Airtable.
- Bot redémarré après 6h : le tableau manquant est publié au démarrage.

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
├── essort/
│   ├── airtable.ts       # Lecture seule du CRM (GET uniquement)
│   ├── planner.ts        # Leads → tâches du jour, à venir, sans date (fonctions pures)
│   ├── service.ts        # Tableaux, synchro Airtable, onglet « Essort » du Sheet
│   ├── ui.ts             # Embed + boutons
│   ├── interactions.ts   # ✔️ ➕ 🗑️ 🔄
│   └── jobs.ts           # 6h, relectures 12h/17h, rattrapage au démarrage
├── db/
│   ├── supabase.ts       # Client Supabase
│   ├── repository.ts     # CRUD typé
│   └── essortRepository.ts
├── lib/
│   ├── embeds.ts         # Builders Discord embeds
│   └── format.ts         # Format date FR
└── scripts/
    └── deploy-commands.ts
```
