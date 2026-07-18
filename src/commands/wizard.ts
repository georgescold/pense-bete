import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  UserSelectMenuInteraction,
} from 'discord.js';
import { logger } from '../logger';
import type { ParsedSchedule } from '../scheduler/parser';
import { computeNextCronRun, type Scheduler } from '../scheduler/scheduler';
import { insertReminder, updateReminder } from '../db/repository';
import { buildAddedEmbed, buildErrorEmbed } from '../lib/embeds';
import { pinMessage } from '../lib/pins';
import { COLORS, COLOR_BY_KEY, DEFAULT_COLOR } from '../lib/presets';
import {
  ESCALATION_SUMMARY,
  currentPeriodValue,
  selectionToDate,
} from '../lib/datetime';
import {
  buildDaySelect,
  buildHourSelect,
  buildMinuteSelect,
  buildPeriodSelect,
} from '../lib/dtpicker';
import {
  buildRecurrence,
  MONTH_DAYS,
  REC_FREQS,
  REC_FREQ_BY_KEY,
  WEEKDAYS,
  type RecFreq,
} from '../lib/recurrence';
import { formatFrenchDate } from '../lib/format';

// --- Choix rapides "ponctuel" ---------------------------------------------

interface QuickOnce {
  key: string;
  label: string;
  ms: number;
}

const QUICK_ONCE: QuickOnce[] = [
  { key: '15min', label: 'Dans 15 minutes', ms: 15 * 60_000 },
  { key: '30min', label: 'Dans 30 minutes', ms: 30 * 60_000 },
  { key: '1h', label: 'Dans 1 heure', ms: 3_600_000 },
  { key: '2h', label: 'Dans 2 heures', ms: 2 * 3_600_000 },
  { key: '4h', label: 'Dans 4 heures', ms: 4 * 3_600_000 },
  { key: '8h', label: 'Dans 8 heures', ms: 8 * 3_600_000 },
  { key: '24h', label: 'Dans 24 heures', ms: 24 * 3_600_000 },
  { key: '2j', label: 'Dans 2 jours', ms: 2 * 86_400_000 },
  { key: '1sem', label: 'Dans 1 semaine', ms: 7 * 86_400_000 },
];
const QUICK_BY_KEY = new Map(QUICK_ONCE.map((q) => [q.key, q]));

// --- État ------------------------------------------------------------------

type Kind = 'once' | 'recurring';
type View = 'main' | 'once_when' | 'once_precise' | 'rec_when';

interface WizardState {
  userId: string;
  channelId: string;
  guildId: string | null;
  texte: string | null;
  kind: Kind | null;
  view: View;
  // Ponctuel
  onceQuickKey: string | null;
  pickPeriod: string | null;
  pickDate: string | null;
  pickHour: number | null;
  pickMin: number | null;
  preciseRunAt: Date | null;
  // Récurrent
  recFreq: RecFreq | null;
  recDays: number[];
  recMonthDay: number | null;
  recHour: number | null;
  recMin: number | null;
  // Commun
  destinataireId: string | null;
  couleurKey: string;
  relance: boolean;
  createdAt: number;
}

const STATES = new Map<string, WizardState>();
const TTL_MS = 15 * 60_000;

function gc(): void {
  const now = Date.now();
  for (const [id, s] of STATES) {
    if (now - s.createdAt > TTL_MS) STATES.delete(id);
  }
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// --- Résumé / validité -----------------------------------------------------

function recurrenceFromState(state: WizardState): ParsedSchedule | null {
  if (!state.recFreq || state.recHour === null || state.recMin === null) return null;
  try {
    return buildRecurrence({
      freq: state.recFreq,
      days: state.recDays,
      monthDay: state.recMonthDay,
      hour: state.recHour,
      minute: state.recMin,
    });
  } catch {
    return null;
  }
}

function quandLabel(state: WizardState): string {
  if (!state.kind) return '*choisis d’abord le type*';
  if (state.kind === 'once') {
    if (state.preciseRunAt) return `📅 ${formatFrenchDate(state.preciseRunAt)}`;
    if (state.onceQuickKey) return `⏱️ ${QUICK_BY_KEY.get(state.onceQuickKey)?.label ?? state.onceQuickKey}`;
    return '*à définir — clique sur « Quand »*';
  }
  const rec = recurrenceFromState(state);
  if (rec) return `🔁 ${rec.humanReadable}`;
  if (state.recFreq) return `🔁 ${REC_FREQ_BY_KEY.get(state.recFreq)?.label ?? state.recFreq} — *complète l’heure*`;
  return '*à définir — clique sur « Quand »*';
}

function isQuandComplete(state: WizardState): boolean {
  if (state.kind === 'once') return !!state.preciseRunAt || !!state.onceQuickKey;
  if (state.kind === 'recurring') return recurrenceFromState(state) !== null;
  return false;
}

function couleurLabel(key: string): string {
  return COLOR_BY_KEY.get(key)?.label ?? key;
}

// --- Embeds ----------------------------------------------------------------

function stateColor(state: WizardState): number {
  return COLOR_BY_KEY.get(state.couleurKey)?.value ?? DEFAULT_COLOR;
}

function buildWizardEmbed(state: WizardState): EmbedBuilder {
  const typeLabel = !state.kind
    ? '*non défini*'
    : state.kind === 'once'
      ? '📅 Ponctuel (une fois)'
      : '🔁 Récurrent (régulier)';
  const embed = new EmbedBuilder()
    .setColor(stateColor(state))
    .setTitle('✏️ Nouveau rappel')
    .setDescription('Choisis le **type**, le **texte**, puis **Quand**. Tout se fait par menus.')
    .addFields(
      { name: '🔀 Type', value: typeLabel, inline: true },
      { name: '⏰ Quand', value: quandLabel(state), inline: true },
      {
        name: '📝 Texte',
        value: state.texte ? `> ${state.texte.slice(0, 300)}` : '*non défini*',
      },
      {
        name: '👤 Destinataire',
        value: state.destinataireId ? `<@${state.destinataireId}>` : `<@${state.userId}> *(vous)*`,
        inline: true,
      },
      { name: '🎨 Couleur', value: couleurLabel(state.couleurKey), inline: true },
    );
  if (state.kind === 'once') {
    embed.addFields({
      name: '🔔 Relance si non validé',
      value: state.relance ? `✅ Activée · ${ESCALATION_SUMMARY}` : '❌ Désactivée',
    });
  }
  return embed;
}

function buildOnceWhenEmbed(state: WizardState): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(stateColor(state))
    .setTitle('⏰ Quand (ponctuel)')
    .setDescription(
      'Choisis un **délai rapide** dans le menu, ou clique **📅 Date & heure précises** pour choisir une date exacte.',
    );
}

function buildPreciseEmbed(state: WizardState): EmbedBuilder {
  const preview =
    state.pickDate && state.pickHour !== null && state.pickMin !== null
      ? formatFrenchDate(selectionToDate(state.pickDate, state.pickHour, state.pickMin))
      : null;
  return new EmbedBuilder()
    .setColor(stateColor(state))
    .setTitle('📅 Date & heure précises')
    .setDescription(
      'Choisis le **mois**, le **jour**, l’**heure**, les **minutes**, puis **Valider**.' +
        (preview ? `\n\n**→ ${preview}**` : '\n\n*Sélection incomplète…*'),
    );
}

function buildRecWhenEmbed(state: WizardState): EmbedBuilder {
  const rec = recurrenceFromState(state);
  return new EmbedBuilder()
    .setColor(stateColor(state))
    .setTitle('🔁 Quand (récurrent)')
    .setDescription(
      'Choisis la **fréquence**' +
        (state.recFreq === 'weekly' ? ', les **jours**' : '') +
        (state.recFreq === 'monthly' ? ', le **jour du mois**' : '') +
        ', l’**heure** et les **minutes**, puis **Valider**.' +
        (rec ? `\n\n**→ ${rec.humanReadable}**` : '\n\n*Sélection incomplète…*'),
    );
}

// --- Composants (selects & boutons) ----------------------------------------

function buildTypeSelect(id: string, state: WizardState): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`wizard:type:${id}`)
    .setPlaceholder('🔀 Type de rappel : ponctuel ou récurrent ?')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('📅 Ponctuel — une seule fois')
        .setValue('once')
        .setDefault(state.kind === 'once'),
      new StringSelectMenuOptionBuilder()
        .setLabel('🔁 Récurrent — régulier (tous les jours, chaque semaine…)')
        .setValue('recurring')
        .setDefault(state.kind === 'recurring'),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildCouleurSelect(id: string, state: WizardState): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`wizard:couleur:${id}`)
    .setPlaceholder('🎨 Couleur')
    .addOptions(
      COLORS.map((c) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(c.label.slice(0, 100))
          .setValue(c.key)
          .setDefault(state.couleurKey === c.key),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildDestSelect(id: string): ActionRowBuilder<UserSelectMenuBuilder> {
  const select = new UserSelectMenuBuilder()
    .setCustomId(`wizard:dest:${id}`)
    .setPlaceholder('👤 Destinataire (vide = toi-même)')
    .setMinValues(0)
    .setMaxValues(1);
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select);
}

function buildMainButtons(id: string, state: WizardState): ActionRowBuilder<ButtonBuilder> {
  const canCreate = !!state.texte && !!state.kind && isQuandComplete(state);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard:btn:texte:${id}`)
      .setLabel(state.texte ? 'Modifier le texte' : 'Texte')
      .setEmoji('📝')
      .setStyle(state.texte ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`wizard:btn:quand:${id}`)
      .setLabel('Quand')
      .setEmoji('⏰')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!state.kind),
  );
  if (state.kind === 'once') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`wizard:btn:relance:${id}`)
        .setLabel(state.relance ? 'Relance : ON' : 'Relance : OFF')
        .setEmoji('🔔')
        .setStyle(state.relance ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard:btn:create:${id}`)
      .setLabel('Créer')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canCreate),
    new ButtonBuilder()
      .setCustomId(`wizard:btn:cancel:${id}`)
      .setLabel('Annuler')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
  return row;
}

function buildOnceQuickSelect(id: string, state: WizardState): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`wizard:oquick:${id}`)
    .setPlaceholder('⏱️ Délai rapide')
    .addOptions(
      QUICK_ONCE.map((q) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(q.label)
          .setValue(q.key)
          .setDefault(state.onceQuickKey === q.key),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildRecFreqSelect(id: string, state: WizardState): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`wizard:rfreq:${id}`)
    .setPlaceholder('🔁 Fréquence')
    .addOptions(
      REC_FREQS.map((f) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(f.label)
          .setValue(f.key)
          .setDefault(state.recFreq === f.key),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildRecDaysSelect(id: string, state: WizardState): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`wizard:rdays:${id}`)
    .setPlaceholder('📆 Jours de la semaine (un ou plusieurs)')
    .setMinValues(1)
    .setMaxValues(WEEKDAYS.length)
    .addOptions(
      WEEKDAYS.map((d) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(d.label)
          .setValue(String(d.value))
          .setDefault(state.recDays.includes(d.value)),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildRecMonthDaySelect(id: string, state: WizardState): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`wizard:rmday:${id}`)
    .setPlaceholder('📅 Jour du mois')
    .addOptions(
      MONTH_DAYS.map((d) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`Le ${d}`)
          .setValue(String(d))
          .setDefault(state.recMonthDay === d),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function subButtons(
  id: string,
  validerAction: string,
  retourAction: string,
  canValidate: boolean,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard:btn:${validerAction}:${id}`)
      .setLabel('Valider')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canValidate),
    new ButtonBuilder()
      .setCustomId(`wizard:btn:${retourAction}:${id}`)
      .setLabel('Retour')
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Secondary),
  );
}

// --- Payloads --------------------------------------------------------------

function buildPayload(id: string, state: WizardState) {
  if (state.view === 'once_when') {
    return {
      embeds: [buildOnceWhenEmbed(state)],
      components: [
        buildOnceQuickSelect(id, state),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`wizard:btn:oprecise:${id}`)
            .setLabel('Date & heure précises')
            .setEmoji('📅')
            .setStyle(ButtonStyle.Primary),
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`wizard:btn:oretour:${id}`)
            .setLabel('Retour')
            .setEmoji('↩️')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
  }

  if (state.view === 'once_precise') {
    const ready = !!state.pickDate && state.pickHour !== null && state.pickMin !== null;
    return {
      embeds: [buildPreciseEmbed(state)],
      components: [
        buildPeriodSelect(`wizard:pperiod:${id}`, state.pickPeriod),
        buildDaySelect(`wizard:pday:${id}`, state.pickPeriod, state.pickDate),
        buildHourSelect(`wizard:phour:${id}`, state.pickHour),
        buildMinuteSelect(`wizard:pmin:${id}`, state.pickMin),
        subButtons(id, 'pvalider', 'pretour', ready),
      ],
    };
  }

  if (state.view === 'rec_when') {
    const rows: (
      | ActionRowBuilder<StringSelectMenuBuilder>
      | ActionRowBuilder<ButtonBuilder>
    )[] = [buildRecFreqSelect(id, state)];
    if (state.recFreq === 'weekly') rows.push(buildRecDaysSelect(id, state));
    else if (state.recFreq === 'monthly') rows.push(buildRecMonthDaySelect(id, state));
    rows.push(buildHourSelect(`wizard:rhour:${id}`, state.recHour));
    rows.push(buildMinuteSelect(`wizard:rmin:${id}`, state.recMin));
    rows.push(subButtons(id, 'rvalider', 'rretour', recurrenceFromState(state) !== null));
    return { embeds: [buildRecWhenEmbed(state)], components: rows };
  }

  // main
  return {
    embeds: [buildWizardEmbed(state)],
    components: [
      buildTypeSelect(id, state),
      buildCouleurSelect(id, state),
      buildDestSelect(id),
      buildMainButtons(id, state),
    ],
  };
}

// --- Entrée ----------------------------------------------------------------

export async function startWizard(interaction: ChatInputCommandInteraction): Promise<void> {
  gc();
  const wizardId = newId();
  const state: WizardState = {
    userId: interaction.user.id,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    texte: null,
    kind: null,
    view: 'main',
    onceQuickKey: null,
    pickPeriod: null,
    pickDate: null,
    pickHour: null,
    pickMin: null,
    preciseRunAt: null,
    recFreq: null,
    recDays: [],
    recMonthDay: null,
    recHour: null,
    recMin: null,
    destinataireId: null,
    couleurKey: 'bleu',
    relance: true,
    createdAt: Date.now(),
  };
  STATES.set(wizardId, state);
  await interaction.reply({ ...buildPayload(wizardId, state), flags: MessageFlags.Ephemeral });
}

// --- Parsing customId ------------------------------------------------------

type SelectKind =
  | 'type'
  | 'couleur'
  | 'dest'
  | 'oquick'
  | 'pperiod'
  | 'pday'
  | 'phour'
  | 'pmin'
  | 'rfreq'
  | 'rdays'
  | 'rmday'
  | 'rhour'
  | 'rmin';

const SELECT_KINDS = new Set<string>([
  'type', 'couleur', 'dest', 'oquick', 'pperiod', 'pday', 'phour', 'pmin',
  'rfreq', 'rdays', 'rmday', 'rhour', 'rmin',
]);

interface ParsedCustomId {
  kind: SelectKind | 'btn' | 'modal';
  action?: string;
  wizardId: string;
}

function parseWizardCustomId(customId: string): ParsedCustomId | null {
  const parts = customId.split(':');
  if (parts[0] !== 'wizard') return null;
  if (parts[1] === 'btn' || parts[1] === 'modal') {
    return { kind: parts[1], action: parts[2], wizardId: parts[3]! };
  }
  if (parts[1] && SELECT_KINDS.has(parts[1])) {
    return { kind: parts[1] as SelectKind, wizardId: parts[2]! };
  }
  return null;
}

function getState(wizardId: string, userId: string): WizardState | null {
  const s = STATES.get(wizardId);
  if (!s || s.userId !== userId) return null;
  return s;
}

async function expireReply(
  interaction:
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction
    | ButtonInteraction
    | ModalSubmitInteraction,
): Promise<void> {
  const payload = {
    embeds: [buildErrorEmbed('Ce formulaire a expiré ou ne vous appartient pas. Relance `/rappel ajouter`.')],
    components: [],
  };
  if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    return;
  }
  await (interaction as ButtonInteraction).update(payload);
}

// --- Handlers : selects ----------------------------------------------------

async function onSelect(
  interaction: StringSelectMenuInteraction | UserSelectMenuInteraction,
  kind: SelectKind,
  wizardId: string,
): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) {
    await expireReply(interaction);
    return;
  }
  const value = interaction.isStringSelectMenu() ? interaction.values[0] : undefined;

  switch (kind) {
    case 'type':
      state.kind = value as Kind;
      break;
    case 'couleur':
      state.couleurKey = value!;
      break;
    case 'dest':
      state.destinataireId = (interaction as UserSelectMenuInteraction).values[0] ?? null;
      break;
    case 'oquick':
      state.onceQuickKey = value!;
      state.preciseRunAt = null; // les deux modes s'excluent
      break;
    case 'pperiod':
      state.pickPeriod = value!;
      state.pickDate = null;
      break;
    case 'pday':
      state.pickDate = value!;
      break;
    case 'phour':
      state.pickHour = Number(value);
      break;
    case 'pmin':
      state.pickMin = Number(value);
      break;
    case 'rfreq':
      state.recFreq = value as RecFreq;
      break;
    case 'rdays':
      state.recDays = (interaction as StringSelectMenuInteraction).values.map(Number);
      break;
    case 'rmday':
      state.recMonthDay = Number(value);
      break;
    case 'rhour':
      state.recHour = Number(value);
      break;
    case 'rmin':
      state.recMin = Number(value);
      break;
  }
  await interaction.update(buildPayload(wizardId, state));
}

// --- Handlers : boutons ----------------------------------------------------

async function onQuand(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state || !state.kind) {
    await expireReply(interaction);
    return;
  }
  if (state.kind === 'once') {
    state.view = 'once_when';
  } else {
    state.view = 'rec_when';
    if (state.recHour === null) state.recHour = 9;
    if (state.recMin === null) state.recMin = 0;
  }
  await interaction.update(buildPayload(wizardId, state));
}

async function onOncePrecise(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  state.view = 'once_precise';
  if (!state.pickPeriod) state.pickPeriod = currentPeriodValue();
  await interaction.update(buildPayload(wizardId, state));
}

async function onPValider(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  if (!state.pickDate || state.pickHour === null || state.pickMin === null) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Choisis le mois, le jour, l’heure et les minutes.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const runAt = selectionToDate(state.pickDate, state.pickHour, state.pickMin);
  if (runAt.getTime() <= Date.now()) {
    await interaction.reply({
      embeds: [buildErrorEmbed(`Cette date est déjà passée : ${formatFrenchDate(runAt)}.`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  state.preciseRunAt = runAt;
  state.onceQuickKey = null;
  state.view = 'main';
  await interaction.update(buildPayload(wizardId, state));
}

async function onRValider(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  if (recurrenceFromState(state) === null) {
    const missing =
      state.recFreq === 'weekly' && state.recDays.length === 0
        ? 'Choisis au moins un jour.'
        : 'Complète la fréquence, l’heure et les minutes.';
    await interaction.reply({
      embeds: [buildErrorEmbed(missing)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  state.view = 'main';
  await interaction.update(buildPayload(wizardId, state));
}

async function onBackToMain(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  state.view = 'main';
  await interaction.update(buildPayload(wizardId, state));
}

async function onBackToOnceWhen(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  state.view = 'once_when';
  await interaction.update(buildPayload(wizardId, state));
}

async function onRelance(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  state.relance = !state.relance;
  await interaction.update(buildPayload(wizardId, state));
}

async function onTexte(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  const modal = new ModalBuilder()
    .setCustomId(`wizard:modal:texte:${wizardId}`)
    .setTitle('Texte du rappel')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('texte')
          .setLabel('Que dois-je te rappeler ?')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(500)
          .setRequired(true)
          .setValue(state.texte ?? ''),
      ),
    );
  await interaction.showModal(modal);
}

async function onCancel(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  STATES.delete(wizardId);
  await interaction.update({
    embeds: [buildErrorEmbed('Création de rappel annulée.')],
    components: [],
  });
}

async function onCreate(
  interaction: ButtonInteraction,
  wizardId: string,
  scheduler: Scheduler,
): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  if (!state.texte || !state.kind || !isQuandComplete(state)) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Il manque le type, le texte ou le moment du rappel.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let parsed: ParsedSchedule;
  let rawInput: string;
  try {
    if (state.kind === 'once') {
      if (state.preciseRunAt) {
        parsed = { type: 'once', runAt: state.preciseRunAt, humanReadable: formatFrenchDate(state.preciseRunAt) };
        rawInput = formatFrenchDate(state.preciseRunAt);
      } else {
        const quick = QUICK_BY_KEY.get(state.onceQuickKey!);
        if (!quick) throw new Error('Délai inconnu.');
        const runAt = new Date(Date.now() + quick.ms);
        parsed = { type: 'once', runAt, humanReadable: formatFrenchDate(runAt) };
        rawInput = quick.label;
      }
    } else {
      const rec = recurrenceFromState(state);
      if (!rec) throw new Error('Récurrence incomplète.');
      parsed = rec;
      rawInput = rec.humanReadable;
    }
  } catch (err) {
    await interaction.reply({
      embeds: [buildErrorEmbed(err instanceof Error ? err.message : 'Erreur de planification')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const color = stateColor(state);
  const nextRunAt = parsed.type === 'once' ? parsed.runAt : computeNextCronRun(parsed.cron, new Date());

  let inserted;
  try {
    inserted = await insertReminder({
      user_id: state.userId,
      channel_id: state.channelId,
      guild_id: state.guildId,
      message: state.texte,
      schedule_type: parsed.type,
      cron_expression: parsed.type === 'recurring' ? parsed.cron : null,
      run_at: parsed.type === 'once' ? parsed.runAt.toISOString() : null,
      next_run_at: nextRunAt.toISOString(),
      raw_input: rawInput,
      is_last_day_of_month: parsed.type === 'recurring' && parsed.isLastDayOfMonth === true,
      color,
      target_user_id: state.destinataireId,
      escalation_enabled: parsed.type === 'once' && state.relance,
    });
  } catch (err) {
    logger.error({ err }, 'wizard insertReminder failed');
    await interaction.reply({
      embeds: [buildErrorEmbed(err instanceof Error ? err.message : 'Erreur DB')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  scheduler.schedule(inserted);
  STATES.delete(wizardId);

  await interaction.update({
    embeds: [buildAddedEmbed(inserted, parsed.humanReadable)],
    components: [],
  });

  try {
    const channel = interaction.channel;
    if (channel && 'send' in channel && typeof channel.send === 'function') {
      const recap = await channel.send({
        embeds: [buildAddedEmbed(inserted, parsed.humanReadable)],
        allowedMentions: { parse: [] },
      });
      const pinned = await pinMessage(recap);
      if (pinned) {
        try {
          await updateReminder(inserted.id, { pin_message_id: recap.id });
        } catch (err) {
          logger.warn({ err, id: inserted.id }, 'failed to store pin_message_id');
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'failed to post public reminder recap');
  }
}

async function onTexteModal(interaction: ModalSubmitInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  state.texte = interaction.fields.getTextInputValue('texte').trim();
  if (interaction.isFromMessage()) {
    await interaction.update(buildPayload(wizardId, state));
  } else {
    await interaction.reply({
      embeds: [buildErrorEmbed('Le formulaire n’est plus accessible. Relance `/rappel ajouter`.')],
      flags: MessageFlags.Ephemeral,
    });
  }
}

// --- Routeur ---------------------------------------------------------------

export function isWizardInteraction(customId: string): boolean {
  return customId.startsWith('wizard:');
}

export async function handleWizardInteraction(
  interaction:
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction
    | ButtonInteraction
    | ModalSubmitInteraction,
  scheduler: Scheduler,
): Promise<void> {
  const parsed = parseWizardCustomId(interaction.customId);
  if (!parsed) return;

  if ((interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) && parsed.kind !== 'btn' && parsed.kind !== 'modal') {
    return onSelect(interaction, parsed.kind, parsed.wizardId);
  }

  if (interaction.isButton() && parsed.kind === 'btn') {
    switch (parsed.action) {
      case 'texte':
        return onTexte(interaction, parsed.wizardId);
      case 'quand':
        return onQuand(interaction, parsed.wizardId);
      case 'oprecise':
        return onOncePrecise(interaction, parsed.wizardId);
      case 'oretour':
        return onBackToMain(interaction, parsed.wizardId);
      case 'pvalider':
        return onPValider(interaction, parsed.wizardId);
      case 'pretour':
        return onBackToOnceWhen(interaction, parsed.wizardId);
      case 'rvalider':
        return onRValider(interaction, parsed.wizardId);
      case 'rretour':
        return onBackToMain(interaction, parsed.wizardId);
      case 'relance':
        return onRelance(interaction, parsed.wizardId);
      case 'create':
        return onCreate(interaction, parsed.wizardId, scheduler);
      case 'cancel':
        return onCancel(interaction, parsed.wizardId);
    }
  }

  if (interaction.isModalSubmit() && parsed.kind === 'modal' && parsed.action === 'texte') {
    return onTexteModal(interaction, parsed.wizardId);
  }
}
