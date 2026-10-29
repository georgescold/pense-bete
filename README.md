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
| `CRM_SECRET` | (Essort) secret de la route `/api/pense-bete/agenda` du CRM, **lecture seule** ; la même valeur que `PENSE_BETE_SECRET` du projet Vercel essort-crm. Sans lui, pas de tableaux |
| `CRM_URL` | (Essort) par défaut `https://crm.essort.agency` |
| `AIRTABLE_TOKEN` / `AIRTABLE_BASE_ID` / `AIRTABLE_LEADS_TABLE` | (ancienne source, plus lue depuis le 28/10/2026) |
| `ESSORT_CRON` | (Essort) par défaut `0 6 * * *` (6h, heure de Paris) |
| `ESSORT_SYNC_CRON` | (Essort) synchro avec le CRM et la base, par défaut `*/5 * * * *` (toutes les 5 minutes) |
| `ESSORT_EVENING_CRON` | (Essort) question « reporter à demain ? », par défaut `0 19 * * *` (19h) |
| `ESSORT_LOYS_CHANNEL_ID` / `ESSORT_ENZO_CHANNEL_ID` | (Essort) salon de chaque tableau ; sans salon, pas de tableau |
| `ESSORT_LOYS_USER_ID` / `ESSORT_ENZO_USER_ID` | (Essort) pour mentionner la personne et réserver les boutons à l'équipe |
| `GOOGLE_CALENDAR_ID` | (Essort) agenda Google tenu à jour par le bot ; pour l'agenda principal d'un compte, son adresse. Vide : aucun agenda |
| `GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON` | (Essort) clé JSON (brute ou base64) du compte de service avec qui l'agenda est partagé ; à défaut, `GOOGLE_SERVICE_ACCOUNT_JSON` |
| `ESSORT_EVENT_MINUTES` | (Essort) durée d'un rendez-vous dans l'agenda, par défaut `60` |

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

## Essort : rendez-vous et tâches du CRM

Depuis le 28/10/2026 le bot lit le **CRM** (crm.essort.agency, espace « ESSORT · Leads du site »)
et non plus la table « Leads » d'Airtable, qui n'est plus tenue à jour.

Chaque jour à 6h, le bot lit le CRM (**sans jamais y écrire**) et poste deux messages dans le salon
de chaque personne (le **responsable** de la fiche ou de la tâche : Loys ou Enzo). Il relit le CRM
toutes les 5 minutes : dès qu'une action change dans le CRM (après un rendez-vous client,
notamment), les messages sont mis à jour sans nouvelle mention et le bot écrit en une ligne ce
qu'il a compris (« Agenda mis à jour depuis le CRM : - Mardi 13/10 · `14:00` R2 avec … »). Au même
rythme, une tâche posée **directement dans la base du bot** (`essort_tasks`, par une autre session
ou un script) apparaît sur le tableau et sonne, sans « 🔄 Actualiser ».

**Lecture du CRM** : une seule route, `GET /api/pense-bete/agenda` (`crm/app/api/pense-bete/agenda/route.ts`),
protégée par `CRM_SECRET` ; elle lit la base dans une transaction `read only`. Elle renvoie :
- la **prochaine action** de chaque fiche : `next_action_at` (jour et heure de Paris ; minuit = un
  jour sans heure, comme le calendrier du CRM) et `next_action_label` ; ni les fiches perdues ni
  les tests. La personne est le dernier événement `assignation` de la fiche ;
- les **tâches du calendrier** pas encore faites (table `taches` : `debut`, `duree_minutes`,
  `journee`, `responsable`, `lead_id`), sur le tableau de leur responsable.

Sans responsable (une tâche « Personne », une fiche jamais attribuée) : le seul prénom de l'équipe
cité dans le texte (« R1 · Enzo appelle Lucie »), sinon **les deux tableaux** (chacun la coche ou la
retire de son côté). Un autre prénom : aucun tableau. Le libellé est celui du CRM, complété du nom
du lead s'il ne le cite pas (« Appel · Camille Dubreuil ») ; sans libellé, l'étape (« R1 », « Relance »).
Dessous : le cabinet, la note d'une tâche, le téléphone s'il faut appeler (et qu'il n'est pas déjà
dans le libellé). Une action dont la date est **passée n'est jamais remise** sur le tableau du jour
(Loys, 29/10) : on la redate dans le CRM, ou on la reporte le soir sur Discord. ⚠️ Le CRM propose
10 h par défaut pour une relance : une relance à venir laissée à 10 h sonne donc à 9 h, 9 h 30 et
9 h 50.

Pour voir ce que le bot posera, sans rien écrire (ni Discord, ni base) :

```bash
npm run apercu-crm      # CRM_URL et CRM_SECRET du .env
```

En base, une tâche venue du CRM garde la source `airtable` (nom d'avant le passage au CRM) et
l'identifiant `lead:<fiche>` ou `tache:<tâche>` (suivi de `@loys` / `@enzo` quand elle est posée sur
les deux tableaux).

**📅 Ta semaine** : les 6 jours suivants (pas aujourd'hui) : actions et tâches du CRM, tâches
planifiées, rappels, chacun à son heure.
- **➕ Planifier** : un jour (d'aujourd'hui à J+24), une tâche, une heure facultative.
- **✏️ Modifier** : une tâche posée sur un jour à venir, ou une action du CRM de la semaine (pour
  lui ajouter une heure, la changer de jour…) : texte, jour, heure, formulaire prérempli. L'action
  du CRM devient alors une tâche de son jour, gardée telle quelle tant que le CRM ne change pas son
  action ou sa date.
- **🗑️ Retirer** : une tâche planifiée sur un jour à venir.
- **⏰ Rappels** : la liste de ses rappels ; ➕ en créer un (même formulaire que `/rappel ajouter`),
  ou en choisir un pour le mettre en pause, le réactiver ou le supprimer.
- **🔄 Actualiser** : relit le CRM tout de suite.

**☀️ Aujourd'hui** : avec mention, seulement ce qu'il y a à faire : la tâche, son heure, le
cabinet ou la note, et le téléphone. Les rappels du jour sont listés dessous.
- **✔️ n** valide une tâche : elle part aussitôt dans l'onglet « Essort » du Google Sheet
  (décocher efface la ligne).
- **➕ Ajouter** (heure facultative), **✏️ Modifier** (texte, jour — « demain », « lundi », « 12/10 » —
  et heure ; changer de jour déplace la tâche, changer d'heure reprogramme ses pings), **🗑️ Retirer**
  n'importe quelle tâche. Une tâche du CRM modifiée ici garde la modification tant que son libellé
  ou sa date ne changent pas dans le CRM. Une tâche du CRM retirée ou validée ici ne revient pas tant
  que son libellé ou sa date ne changent pas dans le CRM (le bot n'écrit rien dans le CRM : la cocher
  sur Discord ne la coche pas dans le CRM).
- **Rien n'est reporté automatiquement.** À 19h, s'il reste des tâches non faites, le bot
  tague la personne et demande lesquelles passer au lendemain : un bouton numéroté par tâche
  (un clic la reporte, un second annule, autant qu'on veut), puis « Terminé », ou « Tout
  reporter ». La question suit le tableau : une tâche cochée après 19h en disparaît, et une tâche
  reportée reste visible dans le message du jour sous « Reporté à demain ». Sans réponse, rien ne
  bouge : les tâches restent affichées sur leur
  jour, non faites. Une action du CRM non reportée ne revient que si sa date ou son libellé
  changent dans le CRM.
- Une tâche à heure fixe (rendez-vous du CRM, tâche ajoutée avec une heure) déclenche trois pings :
  1 h, 30 min et 10 min avant (« ⏰ 14:00 (dans 30 min) · R2 avec… »). Après un redémarrage ou un
  ajout tardif, un seul ping rattrape ceux qui sont passés, avec le temps qui reste.

**Pas de doublon** : une tâche écrite à la main (sur Discord, ou posée en base) l'emporte sur l'action
du CRM qui dit la même chose (même jour, nom du lead ou de son cabinet dans le texte, et même heure à
15 min près, ou deux rendez-vous « rdv / visio / appel » dont l'un n'a pas d'heure). L'action du CRM
n'est alors ni ajoutée, ni montrée dans la semaine, ni annoncée, et ne sonne pas. Les fiches perdues
sont ignorées. Bot redémarré après 6h (ou 19h) : ce qui manque est publié au démarrage, les pings du
jour sont reprogrammés.

### Agenda Google

Si `GOOGLE_CALENDAR_ID` est défini, l'agenda Google suit le planning : chaque rendez-vous **à heure
fixe** (action ou tâche du CRM qui a une heure, tâche posée sur Discord avec une heure) y devient un
événement d'une heure (une tâche du calendrier du CRM : sa durée), « R1 · Enzo appelle … · Enzo »,
avec le détail et le lien de la fiche du CRM en description. Un **rendez-vous client sans heure**
(appel, R1, R2 du CRM, tâche Discord « rdv … ») attend dans le bandeau « toute la journée » de son
jour (« … · heure à fixer ») et passe sur son créneau dès que l'heure est écrite ; les préparations,
relances et envois de documents sans heure n'y vont pas. Un changement sur Discord passe aussitôt ;
un changement dans le CRM, à la relecture suivante (5 minutes au plus). Une tâche retirée sur
Discord, une action déplacée dans le CRM ou une fiche perdue : l'événement est déplacé ou supprimé.

- **Sens unique** : ce qui est changé dans l'agenda ne remonte ni dans le CRM ni sur Discord, et
  la relecture suivante remet l'événement du bot comme le dit le CRM. On modifie dans le CRM ou sur
  Discord.
- Le bot ne touche **qu'à ses événements** (clé privée `essortKey`), d'aujourd'hui à 90 jours : les
  jours passés et les événements écrits à la main ne sont jamais modifiés.
- **Pas de doublon** : un rendez-vous déjà écrit à la main dans l'agenda (même créneau à 15 min près,
  nom du lead ou de son cabinet dans le titre ; le même jour pour un rendez-vous sans heure) l'emporte ; le bot n'en crée pas un second, et retire
  le sien s'il l'avait créé avant.
- Les rappels `/rappel` n'y vont pas.

Mise en place : activer l'API Google Calendar dans le projet Google Cloud du compte de service, puis
partager l'agenda avec l'adresse du compte (Paramètres de l'agenda → Partager avec des personnes
spécifiques → « Apporter des modifications aux événements »).

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
│   ├── reminderPanel.ts  # Panneau « ⏰ Rappels » ouvert depuis un bouton
│   ├── index.ts
│   ├── rappel.ts         # /rappel ajouter|liste|supprimer|pause|reprendre
│   └── types.ts
├── scheduler/
│   ├── parser.ts         # Parsing FR → cron / Date
│   ├── parser.test.ts
│   ├── scheduler.ts      # Map<id, job> + node-cron + long-timeout
│   └── trigger.ts        # Envoi du rappel + update next_run_at
├── essort/
│   ├── crm.ts            # Lecture seule du CRM (une route, GET) → agenda par personne (pur)
│   ├── airtable.ts       # Ancienne lecture d'Airtable, plus appelée (à retirer avec l'accord de Loys)
│   ├── calendarSync.ts   # Rendez-vous à heure fixe → agenda Google (sens unique)
│   ├── planner.ts        # Outils communs : pings, doublons, saisie d'un jour ou d'une heure (pur)
│   ├── service.ts        # Messages semaine + jour, synchro CRM et base, pings, Sheet
│   ├── ui.ts             # Embeds, boutons, menus
│   ├── interactions.ts   # ✔️ ➕ 🗑️ 🔄 et planification
│   └── jobs.ts           # 6h, relectures 12h/17h, rattrapage au démarrage
├── db/
│   ├── supabase.ts       # Client Supabase
│   ├── repository.ts     # CRUD typé
│   └── essortRepository.ts
├── lib/
│   ├── calendar.ts       # Client Google Agenda (compte de service)
│   ├── embeds.ts         # Builders Discord embeds
│   ├── googleAuth.ts     # Jeton Google d'un compte de service (Sheet, agenda)
│   └── format.ts         # Format date FR
└── scripts/
    ├── deploy-commands.ts
    └── apercu-crm.ts     # Ce que le bot posera d'après le CRM, sans rien écrire
```
