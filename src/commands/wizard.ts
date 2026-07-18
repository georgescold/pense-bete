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
import { parseFrenchSchedule, type ParsedSchedule } from '../scheduler/parser';
import { computeNextCronRun, type Scheduler } from '../scheduler/scheduler';
import { insertReminder } from '../db/repository';
import { buildAddedEmbed, buildErrorEmbed } from '../lib/embeds';
import {
  COLORS,
  COLOR_BY_KEY,
  DEFAULT_COLOR,
  PRESETS,
  PRESET_BY_KEY,
} from '../lib/presets';
import { ESCALATION_SUMMARY, selectionToDate } from '../lib/datetime';
import { buildDateSelect, buildHourSelect, buildMinuteSelect } from '../lib/dtpicker';
import { formatFrenchDate } from '../lib/format';

const PRECISE_KEY = 'precise';

interface WizardState {
  userId: string;
  channelId: string;
  guildId: string | null;
  texte: string | null;
  quandKey: string | null;
  quandCustom: string | null;
  destinataireId: string | null;
  couleurKey: string;
  relance: boolean;
  view: 'main' | 'picker';
  pickDate: string | null;
  pickHour: number | null;
  pickMin: number | null;
  preciseRunAt: Date | null;
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

function quandLabel(state: WizardState): string {
  if (!state.quandKey) return '*non défini*';
  if (state.quandKey === PRECISE_KEY) {
    return state.preciseRunAt ? `📅 ${formatFrenchDate(state.preciseRunAt)}` : '📅 *à préciser*';
  }
  if (state.quandKey === 'custom') {
    return state.quandCustom ? `📝 ${state.quandCustom}` : '📝 *à préciser*';
  }
  return PRESET_BY_KEY.get(state.quandKey)?.label ?? state.quandKey;
}

/** true si le « quand » choisi produit un rappel ponctuel (→ relance possible). */
function isOnceSelection(state: WizardState): boolean {
  if (state.quandKey === PRECISE_KEY) return true;
  if (state.quandKey === 'custom') return true; // dépend du texte, on autorise le toggle
  const preset = state.quandKey ? PRESET_BY_KEY.get(state.quandKey) : undefined;
  if (!preset) return false;
  return preset.build(new Date()).type === 'once';
}

function couleurLabel(key: string): string {
  return COLOR_BY_KEY.get(key)?.label ?? key;
}

function buildWizardEmbed(state: WizardState): EmbedBuilder {
  const color = COLOR_BY_KEY.get(state.couleurKey)?.value ?? DEFAULT_COLOR;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle('✏️ Nouveau rappel')
    .setDescription(
      'Remplis les champs ci-dessous puis clique sur **✅ Créer**.\nTu peux modifier chaque champ autant de fois que tu veux.',
    )
    .addFields(
      {
        name: '📝 Texte',
        value: state.texte ? `> ${state.texte.slice(0, 300)}` : '*non défini — clique sur « Texte »*',
      },
      { name: '⏰ Quand', value: quandLabel(state), inline: true },
      {
        name: '👤 Destinataire',
        value: state.destinataireId ? `<@${state.destinataireId}>` : `<@${state.userId}> *(vous)*`,
        inline: true,
      },
      { name: '🎨 Couleur', value: couleurLabel(state.couleurKey), inline: true },
      {
        name: '🔔 Relance si non validé',
        value: isOnceSelection(state)
          ? state.relance
            ? `✅ Activée · ${ESCALATION_SUMMARY}`
            : '❌ Désactivée'
          : '— *(rappel récurrent : sans objet)*',
      },
    );
}

function buildPickerEmbed(state: WizardState): EmbedBuilder {
  const color = COLOR_BY_KEY.get(state.couleurKey)?.value ?? DEFAULT_COLOR;
  const parts: string[] = [];
  parts.push(state.pickDate ? `📅 Jour sélectionné` : '📅 Jour : *à choisir*');
  const preview =
    state.pickDate && state.pickHour !== null && state.pickMin !== null
      ? formatFrenchDate(selectionToDate(state.pickDate, state.pickHour, state.pickMin))
      : null;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle('📅 Date & heure précises')
    .setDescription(
      'Choisis le **jour**, puis l\'**heure**, puis les **minutes**, et clique **Valider**.' +
        (preview ? `\n\n**→ ${preview}**` : '\n\n*Sélection incomplète…*'),
    );
}

function buildQuandSelect(wizardId: string, state: WizardState): ActionRowBuilder<StringSelectMenuBuilder> {
  const preciseOption = new StringSelectMenuOptionBuilder()
    .setLabel('📅 Date & heure précises…')
    .setDescription('Choisir un jour et une heure exacts')
    .setValue(PRECISE_KEY)
    .setDefault(state.quandKey === PRECISE_KEY);
  const options = [
    preciseOption,
    ...PRESETS.map((p) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(p.label.slice(0, 100))
        .setValue(p.key)
        .setDefault(state.quandKey === p.key),
    ),
  ];
  const select = new StringSelectMenuBuilder()
    .setCustomId(`wizard:quand:${wizardId}`)
    .setPlaceholder('⏰ Choisis quand déclencher le rappel')
    .addOptions(options);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildCouleurSelect(wizardId: string, state: WizardState): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = COLORS.map((c) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(c.label.slice(0, 100))
      .setValue(c.key)
      .setDefault(state.couleurKey === c.key),
  );
  const select = new StringSelectMenuBuilder()
    .setCustomId(`wizard:couleur:${wizardId}`)
    .setPlaceholder('🎨 Choisis une couleur')
    .addOptions(options);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildDestSelect(wizardId: string): ActionRowBuilder<UserSelectMenuBuilder> {
  const select = new UserSelectMenuBuilder()
    .setCustomId(`wizard:dest:${wizardId}`)
    .setPlaceholder('👤 Choisis le destinataire (vide = toi-même)')
    .setMinValues(0)
    .setMaxValues(1);
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select);
}

function isQuandComplete(state: WizardState): boolean {
  if (state.quandKey === PRECISE_KEY) return !!state.preciseRunAt;
  if (state.quandKey === 'custom') return !!state.quandCustom;
  return !!state.quandKey;
}

function buildButtonRow(wizardId: string, state: WizardState): ActionRowBuilder<ButtonBuilder> {
  const canCreate = !!state.texte && isQuandComplete(state);
  const showRelance = isOnceSelection(state);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard:btn:texte:${wizardId}`)
      .setLabel(state.texte ? 'Modifier le texte' : 'Texte du rappel')
      .setEmoji('📝')
      .setStyle(state.texte ? ButtonStyle.Secondary : ButtonStyle.Primary),
  );
  if (showRelance) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`wizard:btn:relance:${wizardId}`)
        .setLabel(state.relance ? 'Relance : ON' : 'Relance : OFF')
        .setEmoji('🔔')
        .setStyle(state.relance ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard:btn:create:${wizardId}`)
      .setLabel('Créer')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canCreate),
    new ButtonBuilder()
      .setCustomId(`wizard:btn:cancel:${wizardId}`)
      .setLabel('Annuler')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
  return row;
}

function buildPickerButtonRow(wizardId: string, state: WizardState): ActionRowBuilder<ButtonBuilder> {
  const ready = !!state.pickDate && state.pickHour !== null && state.pickMin !== null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard:btn:pvalider:${wizardId}`)
      .setLabel('Valider')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!ready),
    new ButtonBuilder()
      .setCustomId(`wizard:btn:pretour:${wizardId}`)
      .setLabel('Retour')
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildPayload(wizardId: string, state: WizardState) {
  if (state.view === 'picker') {
    return {
      embeds: [buildPickerEmbed(state)],
      components: [
        buildDateSelect(`wizard:pdate:${wizardId}`, state.pickDate),
        buildHourSelect(`wizard:phour:${wizardId}`, state.pickHour),
        buildMinuteSelect(`wizard:pmin:${wizardId}`, state.pickMin),
        buildPickerButtonRow(wizardId, state),
      ],
    };
  }
  return {
    embeds: [buildWizardEmbed(state)],
    components: [
      buildQuandSelect(wizardId, state),
      buildCouleurSelect(wizardId, state),
      buildDestSelect(wizardId),
      buildButtonRow(wizardId, state),
    ],
  };
}

export async function startWizard(interaction: ChatInputCommandInteraction): Promise<void> {
  gc();
  const wizardId = newId();
  const state: WizardState = {
    userId: interaction.user.id,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    texte: null,
    quandKey: null,
    quandCustom: null,
    destinataireId: null,
    couleurKey: 'bleu',
    relance: true,
    view: 'main',
    pickDate: null,
    pickHour: null,
    pickMin: null,
    preciseRunAt: null,
    createdAt: Date.now(),
  };
  STATES.set(wizardId, state);

  await interaction.reply({
    ...buildPayload(wizardId, state),
    flags: MessageFlags.Ephemeral,
  });
}

type WizardKind =
  | 'quand'
  | 'couleur'
  | 'dest'
  | 'pdate'
  | 'phour'
  | 'pmin'
  | 'btn'
  | 'modal';

function parseWizardCustomId(customId: string): {
  kind: WizardKind;
  action?: string;
  wizardId: string;
} | null {
  const parts = customId.split(':');
  if (parts[0] !== 'wizard') return null;
  if (parts[1] === 'btn' || parts[1] === 'modal') {
    return { kind: parts[1] as 'btn' | 'modal', action: parts[2], wizardId: parts[3]! };
  }
  if (
    parts[1] === 'quand' ||
    parts[1] === 'couleur' ||
    parts[1] === 'dest' ||
    parts[1] === 'pdate' ||
    parts[1] === 'phour' ||
    parts[1] === 'pmin'
  ) {
    return { kind: parts[1] as WizardKind, wizardId: parts[2]! };
  }
  return null;
}

function getState(wizardId: string, userId: string): WizardState | null {
  const s = STATES.get(wizardId);
  if (!s) return null;
  if (s.userId !== userId) return null;
  return s;
}

async function expireReply(
  interaction: StringSelectMenuInteraction | UserSelectMenuInteraction | ButtonInteraction | ModalSubmitInteraction,
): Promise<void> {
  const payload = {
    embeds: [buildErrorEmbed('Ce formulaire a expiré ou a été créé par quelqu\'un d\'autre. Relance `/rappel ajouter`.')],
    components: [],
  };
  if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    return;
  }
  await (interaction as ButtonInteraction).update(payload);
}

async function handleQuandSelect(interaction: StringSelectMenuInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) {
    await expireReply(interaction);
    return;
  }
  const value = interaction.values[0]!;
  state.quandKey = value;
  if (value !== 'custom') state.quandCustom = null;

  if (value === PRECISE_KEY) {
    state.view = 'picker';
    await interaction.update(buildPayload(wizardId, state));
    return;
  }

  if (value === 'custom') {
    const modal = new ModalBuilder()
      .setCustomId(`wizard:modal:quandperso:${wizardId}`)
      .setTitle('Expression personnalisée')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('quandperso')
            .setLabel('Ex: "demain 9h", "tous les jeudis à 14h30"')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(200)
            .setRequired(true)
            .setValue(state.quandCustom ?? ''),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  await interaction.update(buildPayload(wizardId, state));
}

async function handleCouleurSelect(interaction: StringSelectMenuInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) {
    await expireReply(interaction);
    return;
  }
  state.couleurKey = interaction.values[0]!;
  await interaction.update(buildPayload(wizardId, state));
}

async function handleDestSelect(interaction: UserSelectMenuInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) {
    await expireReply(interaction);
    return;
  }
  state.destinataireId = interaction.values[0] ?? null;
  await interaction.update(buildPayload(wizardId, state));
}

async function handlePickerSelect(
  interaction: StringSelectMenuInteraction,
  wizardId: string,
  field: 'pdate' | 'phour' | 'pmin',
): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) {
    await expireReply(interaction);
    return;
  }
  const value = interaction.values[0]!;
  if (field === 'pdate') state.pickDate = value;
  else if (field === 'phour') state.pickHour = Number(value);
  else state.pickMin = Number(value);
  await interaction.update(buildPayload(wizardId, state));
}

async function handlePickerValider(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) {
    await expireReply(interaction);
    return;
  }
  if (!state.pickDate || state.pickHour === null || state.pickMin === null) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Choisis le jour, l\'heure et les minutes avant de valider.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const runAt = selectionToDate(state.pickDate, state.pickHour, state.pickMin);
  if (runAt.getTime() <= Date.now()) {
    await interaction.reply({
      embeds: [buildErrorEmbed(`Cette date est déjà passée : ${formatFrenchDate(runAt)}. Choisis un moment futur.`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  state.preciseRunAt = runAt;
  state.quandKey = PRECISE_KEY;
  state.view = 'main';
  await interaction.update(buildPayload(wizardId, state));
}

async function handlePickerRetour(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) {
    await expireReply(interaction);
    return;
  }
  state.view = 'main';
  // Si aucune date validée, on annule le choix « précis ».
  if (!state.preciseRunAt && state.quandKey === PRECISE_KEY) state.quandKey = null;
  await interaction.update(buildPayload(wizardId, state));
}

async function handleRelanceButton(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) {
    await expireReply(interaction);
    return;
  }
  state.relance = !state.relance;
  await interaction.update(buildPayload(wizardId, state));
}

async function handleTexteButton(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) {
    await expireReply(interaction);
    return;
  }
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

async function handleCancelButton(interaction: ButtonInteraction, wizardId: string): Promise<void> {
  STATES.delete(wizardId);
  await interaction.update({
    embeds: [buildErrorEmbed('Création de rappel annulée.')],
    components: [],
  });
}

async function handleCreateButton(
  interaction: ButtonInteraction,
  wizardId: string,
  scheduler: Scheduler,
): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) {
    await expireReply(interaction);
    return;
  }
  if (!state.texte || !state.quandKey) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Il manque le texte ou le moment du rappel.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let parsed: ParsedSchedule;
  let rawInput: string;
  try {
    if (state.quandKey === PRECISE_KEY) {
      if (!state.preciseRunAt) {
        await interaction.reply({
          embeds: [buildErrorEmbed('Aucune date précise validée. Resélectionne « Date & heure précises ».')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      parsed = {
        type: 'once',
        runAt: state.preciseRunAt,
        humanReadable: formatFrenchDate(state.preciseRunAt),
      };
      rawInput = formatFrenchDate(state.preciseRunAt);
    } else if (state.quandKey === 'custom') {
      if (!state.quandCustom) {
        await interaction.reply({
          embeds: [buildErrorEmbed('L\'expression personnalisée est vide. Resélectionne « Personnalisé ».')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      parsed = parseFrenchSchedule(state.quandCustom);
      rawInput = state.quandCustom;
    } else {
      const preset = PRESET_BY_KEY.get(state.quandKey);
      if (!preset) throw new Error(`Choix inconnu : ${state.quandKey}`);
      parsed = preset.build(new Date());
      rawInput = preset.label;
    }
  } catch (err) {
    await interaction.reply({
      embeds: [buildErrorEmbed(err instanceof Error ? err.message : 'Erreur de planification')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const color = COLOR_BY_KEY.get(state.couleurKey)?.value ?? DEFAULT_COLOR;
  const nextRunAt =
    parsed.type === 'once' ? parsed.runAt : computeNextCronRun(parsed.cron, new Date());

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
      // La relance ("réveil") ne concerne que les rappels ponctuels.
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

  // Le wizard lui-même est ephemeral (formulaire personnel) → on le ferme
  // par une confirmation courte, puis on publie le récap publiquement dans le channel.
  await interaction.update({
    embeds: [buildAddedEmbed(inserted, parsed.humanReadable)],
    components: [],
  });

  try {
    const channel = interaction.channel;
    if (channel && 'send' in channel && typeof channel.send === 'function') {
      await channel.send({
        embeds: [buildAddedEmbed(inserted, parsed.humanReadable)],
        allowedMentions: { parse: [] },
      });
    }
  } catch (err) {
    logger.warn({ err }, 'failed to post public reminder recap');
  }
}

async function handleTexteModal(interaction: ModalSubmitInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) {
    await expireReply(interaction);
    return;
  }
  state.texte = interaction.fields.getTextInputValue('texte').trim();
  if (interaction.isFromMessage()) {
    await interaction.update(buildPayload(wizardId, state));
  } else {
    await interaction.reply({
      embeds: [buildErrorEmbed('Le formulaire n\'est plus accessible. Relance `/rappel ajouter`.')],
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleQuandPersoModal(interaction: ModalSubmitInteraction, wizardId: string): Promise<void> {
  const state = getState(wizardId, interaction.user.id);
  if (!state) {
    await expireReply(interaction);
    return;
  }
  state.quandKey = 'custom';
  state.quandCustom = interaction.fields.getTextInputValue('quandperso').trim();
  if (interaction.isFromMessage()) {
    await interaction.update(buildPayload(wizardId, state));
  } else {
    await interaction.reply({
      embeds: [buildErrorEmbed('Le formulaire n\'est plus accessible. Relance `/rappel ajouter`.')],
      flags: MessageFlags.Ephemeral,
    });
  }
}

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

  if (interaction.isStringSelectMenu()) {
    if (parsed.kind === 'quand') return handleQuandSelect(interaction, parsed.wizardId);
    if (parsed.kind === 'couleur') return handleCouleurSelect(interaction, parsed.wizardId);
    if (parsed.kind === 'pdate' || parsed.kind === 'phour' || parsed.kind === 'pmin') {
      return handlePickerSelect(interaction, parsed.wizardId, parsed.kind);
    }
  }
  if (interaction.isUserSelectMenu() && parsed.kind === 'dest') {
    return handleDestSelect(interaction, parsed.wizardId);
  }
  if (interaction.isButton() && parsed.kind === 'btn') {
    if (parsed.action === 'texte') return handleTexteButton(interaction, parsed.wizardId);
    if (parsed.action === 'create') return handleCreateButton(interaction, parsed.wizardId, scheduler);
    if (parsed.action === 'cancel') return handleCancelButton(interaction, parsed.wizardId);
    if (parsed.action === 'relance') return handleRelanceButton(interaction, parsed.wizardId);
    if (parsed.action === 'pvalider') return handlePickerValider(interaction, parsed.wizardId);
    if (parsed.action === 'pretour') return handlePickerRetour(interaction, parsed.wizardId);
  }
  if (interaction.isModalSubmit() && parsed.kind === 'modal') {
    if (parsed.action === 'texte') return handleTexteModal(interaction, parsed.wizardId);
    if (parsed.action === 'quandperso') return handleQuandPersoModal(interaction, parsed.wizardId);
  }
}
