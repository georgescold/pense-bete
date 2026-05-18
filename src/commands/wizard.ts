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

interface WizardState {
  userId: string;
  channelId: string;
  guildId: string | null;
  texte: string | null;
  quandKey: string | null;
  quandCustom: string | null;
  destinataireId: string | null;
  couleurKey: string;
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
  if (state.quandKey === 'custom') {
    return state.quandCustom ? `📝 ${state.quandCustom}` : '📝 *à préciser*';
  }
  return PRESET_BY_KEY.get(state.quandKey)?.label ?? state.quandKey;
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
    );
}

function buildQuandSelect(wizardId: string, state: WizardState): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = PRESETS.map((p) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(p.label.slice(0, 100))
      .setValue(p.key)
      .setDefault(state.quandKey === p.key),
  );
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

function buildButtonRow(wizardId: string, state: WizardState): ActionRowBuilder<ButtonBuilder> {
  const canCreate =
    !!state.texte &&
    !!state.quandKey &&
    (state.quandKey !== 'custom' || !!state.quandCustom);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard:btn:texte:${wizardId}`)
      .setLabel(state.texte ? 'Modifier le texte' : 'Texte du rappel')
      .setEmoji('📝')
      .setStyle(state.texte ? ButtonStyle.Secondary : ButtonStyle.Primary),
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
}

function buildPayload(wizardId: string, state: WizardState) {
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
    createdAt: Date.now(),
  };
  STATES.set(wizardId, state);

  await interaction.reply({
    ...buildPayload(wizardId, state),
    flags: MessageFlags.Ephemeral,
  });
}

function parseWizardCustomId(customId: string): {
  kind: 'quand' | 'couleur' | 'dest' | 'btn' | 'modal';
  action?: string;
  wizardId: string;
} | null {
  const parts = customId.split(':');
  if (parts[0] !== 'wizard') return null;
  if (parts[1] === 'btn' || parts[1] === 'modal') {
    return { kind: parts[1] as 'btn' | 'modal', action: parts[2], wizardId: parts[3]! };
  }
  if (parts[1] === 'quand' || parts[1] === 'couleur' || parts[1] === 'dest') {
    return { kind: parts[1] as 'quand' | 'couleur' | 'dest', wizardId: parts[2]! };
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
    if (state.quandKey === 'custom') {
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
  }
  if (interaction.isUserSelectMenu() && parsed.kind === 'dest') {
    return handleDestSelect(interaction, parsed.wizardId);
  }
  if (interaction.isButton() && parsed.kind === 'btn') {
    if (parsed.action === 'texte') return handleTexteButton(interaction, parsed.wizardId);
    if (parsed.action === 'create') return handleCreateButton(interaction, parsed.wizardId, scheduler);
    if (parsed.action === 'cancel') return handleCancelButton(interaction, parsed.wizardId);
  }
  if (interaction.isModalSubmit() && parsed.kind === 'modal') {
    if (parsed.action === 'texte') return handleTexteModal(interaction, parsed.wizardId);
    if (parsed.action === 'quandperso') return handleQuandPersoModal(interaction, parsed.wizardId);
  }
}
