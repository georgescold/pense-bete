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
import { ESCALATION_SUMMARY, currentPeriodValue, selectionToDate } from '../lib/datetime';
import {
  buildDaySelect,
  buildHourSelect,
  buildMinuteTensSelect,
  buildMinuteUnitsSelect,
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

// --- État ------------------------------------------------------------------

type Kind = 'once' | 'recurring';
type View = 'main' | 'once_date' | 'once_time' | 'rec_config' | 'rec_time';

interface WizardState {
  userId: string;
  channelId: string;
  guildId: string | null;
  texte: string | null;
  kind: Kind | null;
  view: View;
  // Ponctuel — date
  pickPeriod: string | null;
  pickDate: string | null;
  // Ponctuel — heure
  pickHour: number | null;
  pickMinTens: number | null;
  pickMinUnits: number | null;
  preciseRunAt: Date | null;
  // Récurrent
  recFreq: RecFreq | null;
  recDays: number[];
  recMonthDay: number | null;
  recHour: number | null;
  recMinTens: number | null;
  recMinUnits: number | null;
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

function minuteOf(tens: number | null, units: number | null): number {
  return (tens ?? 0) + (units ?? 0);
}

// --- Résumé / validité -----------------------------------------------------

function recurrenceFromState(state: WizardState): ParsedSchedule | null {
  if (!state.recFreq || state.recHour === null || state.recMinTens === null) return null;
  try {
    return buildRecurrence({
      freq: state.recFreq,
      days: state.recDays,
      monthDay: state.recMonthDay,
      hour: state.recHour,
      minute: minuteOf(state.recMinTens, state.recMinUnits),
    });
  } catch {
    return null;
  }
}

function onceRunAt(state: WizardState): Date | null {
  if (state.preciseRunAt) return state.preciseRunAt;
  if (state.pickDate && state.pickHour !== null && state.pickMinTens !== null) {
    return selectionToDate(state.pickDate, state.pickHour, minuteOf(state.pickMinTens, state.pickMinUnits));
  }
  return null;
}

function quandLabel(state: WizardState): string {
  if (!state.kind) return '*choisis d’abord le type*';
  if (state.kind === 'once') {
    const at = onceRunAt(state);
    return at ? `📅 ${formatFrenchDate(at)}` : '*à définir — clique sur « Quand »*';
  }
  const rec = recurrenceFromState(state);
  if (rec) return `🔁 ${rec.humanReadable}`;
  if (state.recFreq) return `🔁 ${REC_FREQ_BY_KEY.get(state.recFreq)?.label ?? state.recFreq} — *complète l’heure*`;
  return '*à définir — clique sur « Quand »*';
}

function isQuandComplete(state: WizardState): boolean {
  if (state.kind === 'once') return !!state.preciseRunAt;
  if (state.kind === 'recurring') return recurrenceFromState(state) !== null;
  return false;
}

function couleurLabel(key: string): string {
  return COLOR_BY_KEY.get(key)?.label ?? key;
}

function timePreview(hour: number | null, tens: number | null, units: number | null): string {
  if (hour === null || tens === null) return '*Heure incomplète…*';
  const m = minuteOf(tens, units);
  return `**${hour.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}**`;
}

// --- Embeds ----------------------------------------------------------------

function stateColor(state: WizardState): number {
  return COLOR_BY_KEY.get(state.couleurKey)?.value ?? DEFAULT_COLOR;
}

function buildMainEmbed(state: WizardState): EmbedBuilder {
  const typeLabel = !state.kind
    ? '*non défini*'
    : state.kind === 'once'
      ? '📅 Ponctuel (une fois)'
      : '🔁 Récurrent (régulier)';
  const embed = new EmbedBuilder()
    .setColor(stateColor(state))
    .setTitle('✏️ Nouveau rappel')
    .setDescription('Choisis le **type** — tu passeras ensuite au **jour/date puis à l’heure**.')
    .addFields(
      { name: '🔀 Type', value: typeLabel, inline: true },
      { name: '⏰ Quand', value: quandLabel(state), inline: true },
      { name: '📝 Texte', value: state.texte ? `> ${state.texte.slice(0, 300)}` : '*non défini*' },
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

function buildOnceDateEmbed(state: WizardState): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(stateColor(state))
    .setTitle('📅 Étape 1/2 — Jour')
    .setDescription('Choisis le **mois** puis le **jour**, puis clique **Suivant** pour l’heure.');
}

function buildOnceTimeEmbed(state: WizardState): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(stateColor(state))
    .setTitle('🕐 Étape 2/2 — Heure')
    .setDescription(
      `Jour choisi. Sélectionne l’**heure** et les **minutes** (dizaines + unités), puis **Valider**.\n\n→ ${timePreview(state.pickHour, state.pickMinTens, state.pickMinUnits)}`,
    );
}

function buildRecConfigEmbed(state: WizardState): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(stateColor(state))
    .setTitle('🔁 Étape 1/2 — Fréquence')
    .setDescription(
      'Choisis la **fréquence**' +
        (state.recFreq === 'weekly' ? ' et les **jours**' : '') +
        (state.recFreq === 'monthly' ? ' et le **jour du mois**' : '') +
        ', puis **Suivant** pour l’heure.',
    );
}

function buildRecTimeEmbed(state: WizardState): EmbedBuilder {
  const rec = recurrenceFromState(state);
  return new EmbedBuilder()
    .setColor(stateColor(state))
    .setTitle('🕐 Étape 2/2 — Heure')
    .setDescription(
      `Sélectionne l’**heure** et les **minutes**, puis **Valider**.\n\n→ ${timePreview(state.recHour, state.recMinTens, state.recMinUnits)}` +
        (rec ? `\n\n🔁 ${rec.humanReadable}` : ''),
    );
}

// --- Composants ------------------------------------------------------------

function buildTypeSelect(id: string, state: WizardState): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`wizard:type:${id}`)
    .setPlaceholder('🔀 Type : ponctuel ou récurrent ?')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('📅 Ponctuel — une seule fois')
        .setValue('once')
        .setDefault(state.kind === 'once'),
      new StringSelectMenuOptionBuilder()
        .setLabel('🔁 Récurrent — régulier')
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
    .setPlaceholder('📆 Jours (un ou plusieurs)')
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

function navButtons(
  id: string,
  primaryAction: string,
  primaryLabel: string,
  backAction: string,
  primaryEnabled: boolean,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard:btn:${primaryAction}:${id}`)
      .setLabel(primaryLabel)
      .setEmoji(primaryLabel === 'Valider' ? '✅' : '➡️')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!primaryEnabled),
    new ButtonBuilder()
      .setCustomId(`wizard:btn:${backAction}:${id}`)
      .setLabel('Retour')
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Secondary),
  );
}

// --- Payloads --------------------------------------------------------------

function buildPayload(id: string, state: WizardState) {
  switch (state.view) {
    case 'once_date':
      return {
        embeds: [buildOnceDateEmbed(state)],
        components: [
          buildPeriodSelect(`wizard:pperiod:${id}`, state.pickPeriod),
          buildDaySelect(`wizard:pday:${id}`, state.pickPeriod, state.pickDate),
          navButtons(id, 'odatenext', 'Suivant', 'odateback', !!state.pickDate),
        ],
      };
    case 'once_time':
      return {
        embeds: [buildOnceTimeEmbed(state)],
        components: [
          buildHourSelect(`wizard:phour:${id}`, state.pickHour),
          buildMinuteTensSelect(`wizard:pmintens:${id}`, state.pickMinTens),
          buildMinuteUnitsSelect(`wizard:pminunits:${id}`, state.pickMinUnits),
          navButtons(id, 'ovalider', 'Valider', 'otimeback', state.pickHour !== null && state.pickMinTens !== null),
        ],
      };
    case 'rec_config': {
      const rows: (
        | ActionRowBuilder<StringSelectMenuBuilder>
        | ActionRowBuilder<ButtonBuilder>
      )[] = [buildRecFreqSelect(id, state)];
      if (state.recFreq === 'weekly') rows.push(buildRecDaysSelect(id, state));
      else if (state.recFreq === 'monthly') rows.push(buildRecMonthDaySelect(id, state));
      const depsOk =
        !!state.recFreq &&
        (state.recFreq !== 'weekly' || state.recDays.length > 0) &&
        (state.recFreq !== 'monthly' || state.recMonthDay !== null);
      rows.push(navButtons(id, 'rconfignext', 'Suivant', 'rconfigback', depsOk));
      return { embeds: [buildRecConfigEmbed(state)], components: rows };
    }
    case 'rec_time':
      return {
        embeds: [buildRecTimeEmbed(state)],
        components: [
          buildHourSelect(`wizard:rhour:${id}`, state.recHour),
          buildMinuteTensSelect(`wizard:rmintens:${id}`, state.recMinTens),
          buildMinuteUnitsSelect(`wizard:rminunits:${id}`, state.recMinUnits),
          navButtons(id, 'rvalider', 'Valider', 'rtimeback', state.recHour !== null && state.recMinTens !== null),
        ],
      };
    default:
      return {
        embeds: [buildMainEmbed(state)],
        components: [
          buildTypeSelect(id, state),
          buildCouleurSelect(id, state),
          buildDestSelect(id),
          buildMainButtons(id, state),
        ],
      };
  }
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
    pickPeriod: null,
    pickDate: null,
    pickHour: null,
    pickMinTens: null,
    pickMinUnits: null,
    preciseRunAt: null,
    recFreq: null,
    recDays: [],
    recMonthDay: null,
    recHour: null,
    recMinTens: null,
    recMinUnits: null,
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
  | 'pperiod'
  | 'pday'
  | 'phour'
  | 'pmintens'
  | 'pminunits'
  | 'rfreq'
  | 'rdays'
  | 'rmday'
  | 'rhour'
  | 'rmintens'
  | 'rminunits';

const SELECT_KINDS = new Set<string>([
  'type', 'couleur', 'dest', 'pperiod', 'pday', 'phour', 'pmintens', 'pminunits',
  'rfreq', 'rdays', 'rmday', 'rhour', 'rmintens', 'rminunits',
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
  if (!state) return expireReply(interaction);
  const value = interaction.isStringSelectMenu() ? interaction.values[0] : undefined;

  switch (kind) {
    case 'type':
      // Choix du type → on enchaîne directement sur le choix du jour/fréquence.
      state.kind = value as Kind;
      if (state.kind === 'once') {
        state.view = 'once_date';
        if (!state.pickPeriod) state.pickPeriod = currentPeriodValue();
      } else {
        state.view = 'rec_config';
      }
      break;
    case 'couleur':
      state.couleurKey = value!;
      break;
    case 'dest':
      state.destinataireId = (interaction as UserSelectMenuInteraction).values[0] ?? null;
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
    case 'pmintens':
      state.pickMinTens = Number(value);
      break;
    case 'pminunits':
      state.pickMinUnits = Number(value);
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
    case 'rmintens':
      state.recMinTens = Number(value);
      break;
    case 'rminunits':
      state.recMinUnits = Number(value);
      break;
  }
  await interaction.update(buildPayload(wizardId, state));
}

// --- Handlers : boutons ----------------------------------------------------

async function onQuand(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state || !state.kind) return expireReply(interaction);
  if (state.kind === 'once') {
    state.view = 'once_date';
    if (!state.pickPeriod) state.pickPeriod = currentPeriodValue();
  } else {
    state.view = 'rec_config';
  }
  await interaction.update(buildPayload(wizardId, state));
}

async function onOnceDateNext(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  if (!state.pickDate) {
    await interaction.reply({ embeds: [buildErrorEmbed('Choisis d’abord le jour.')], flags: MessageFlags.Ephemeral });
    return;
  }
  state.view = 'once_time';
  await interaction.update(buildPayload(wizardId, state));
}

async function onOnceValider(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  if (!state.pickDate || state.pickHour === null || state.pickMinTens === null) {
    await interaction.reply({ embeds: [buildErrorEmbed('Choisis le jour, l’heure et les minutes.')], flags: MessageFlags.Ephemeral });
    return;
  }
  const runAt = selectionToDate(state.pickDate, state.pickHour, minuteOf(state.pickMinTens, state.pickMinUnits));
  if (runAt.getTime() <= Date.now()) {
    await interaction.reply({
      embeds: [buildErrorEmbed(`Cette date est déjà passée : ${formatFrenchDate(runAt)}.`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  state.preciseRunAt = runAt;
  state.view = 'main';
  await interaction.update(buildPayload(wizardId, state));
}

async function onRecConfigNext(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  const depsOk =
    !!state.recFreq &&
    (state.recFreq !== 'weekly' || state.recDays.length > 0) &&
    (state.recFreq !== 'monthly' || state.recMonthDay !== null);
  if (!depsOk) {
    await interaction.reply({ embeds: [buildErrorEmbed('Complète la fréquence (et les jours si besoin).')], flags: MessageFlags.Ephemeral });
    return;
  }
  state.view = 'rec_time';
  if (state.recHour === null) state.recHour = 9;
  if (state.recMinTens === null) state.recMinTens = 0;
  await interaction.update(buildPayload(wizardId, state));
}

async function onRecValider(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  if (recurrenceFromState(state) === null) {
    await interaction.reply({ embeds: [buildErrorEmbed('Complète la fréquence, l’heure et les minutes.')], flags: MessageFlags.Ephemeral });
    return;
  }
  state.view = 'main';
  await interaction.update(buildPayload(wizardId, state));
}

async function onBack(interaction: ButtonInteraction, wizardId: string, to: View): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) return expireReply(interaction);
  state.view = to;
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
  await interaction.update({ embeds: [buildErrorEmbed('Création de rappel annulée.')], components: [] });
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
      const runAt = state.preciseRunAt!;
      parsed = { type: 'once', runAt, humanReadable: formatFrenchDate(runAt) };
      rawInput = formatFrenchDate(runAt);
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

  await interaction.update({ embeds: [buildAddedEmbed(inserted, parsed.humanReadable)], components: [] });

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

  if (
    (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) &&
    parsed.kind !== 'btn' &&
    parsed.kind !== 'modal'
  ) {
    return onSelect(interaction, parsed.kind, parsed.wizardId);
  }

  if (interaction.isButton() && parsed.kind === 'btn') {
    switch (parsed.action) {
      case 'texte':
        return onTexte(interaction, parsed.wizardId);
      case 'quand':
        return onQuand(interaction, parsed.wizardId);
      case 'odatenext':
        return onOnceDateNext(interaction, parsed.wizardId);
      case 'odateback':
        return onBack(interaction, parsed.wizardId, 'main');
      case 'ovalider':
        return onOnceValider(interaction, parsed.wizardId);
      case 'otimeback':
        return onBack(interaction, parsed.wizardId, 'once_date');
      case 'rconfignext':
        return onRecConfigNext(interaction, parsed.wizardId);
      case 'rconfigback':
        return onBack(interaction, parsed.wizardId, 'main');
      case 'rvalider':
        return onRecValider(interaction, parsed.wizardId);
      case 'rtimeback':
        return onBack(interaction, parsed.wizardId, 'rec_config');
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
