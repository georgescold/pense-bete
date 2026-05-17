import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { z } from 'zod';
import { logger } from '../logger';
import { parseFrenchSchedule, type ParsedSchedule } from '../scheduler/parser';
import { computeNextCronRun } from '../scheduler/scheduler';
import {
  deleteReminder,
  getReminderById,
  insertReminder,
  listRemindersByUser,
  setPaused,
} from '../db/repository';
import {
  buildAddedEmbed,
  buildErrorEmbed,
  buildListEmbed,
  buildSuccessEmbed,
} from '../lib/embeds';
import {
  COLORS,
  COLOR_BY_KEY,
  DEFAULT_COLOR,
  PRESETS,
  PRESET_BY_KEY,
} from '../lib/presets';
import type { Command } from './types';

const messageSchema = z.string().trim().min(1).max(500);

const data = new SlashCommandBuilder()
  .setName('rappel')
  .setDescription('Gérer vos rappels (pense-bête)')
  .setDMPermission(true)
  .addSubcommand((s) =>
    s
      .setName('ajouter')
      .setDescription('Ajouter un nouveau rappel')
      .addStringOption((o) =>
        o
          .setName('texte')
          .setDescription('Contenu du rappel (max 500 caractères)')
          .setRequired(true)
          .setMaxLength(500),
      )
      .addStringOption((o) => {
        o.setName('quand').setDescription('Quand déclencher le rappel').setRequired(true);
        for (const p of PRESETS) {
          o.addChoices({ name: p.label, value: p.key });
        }
        return o;
      })
      .addStringOption((o) =>
        o
          .setName('quand_personnalise')
          .setDescription(
            'Si quand=Personnalisé : ex. "demain 9h", "tous les jeudis à 14h30"',
          )
          .setRequired(false),
      )
      .addUserOption((o) =>
        o
          .setName('destinataire')
          .setDescription('Qui mentionner (vous-même par défaut)')
          .setRequired(false),
      )
      .addStringOption((o) => {
        o
          .setName('couleur')
          .setDescription('Couleur / catégorie du rappel (bleu par défaut)')
          .setRequired(false);
        for (const c of COLORS) {
          o.addChoices({ name: c.label, value: c.key });
        }
        return o;
      }),
  )
  .addSubcommand((s) => s.setName('liste').setDescription('Lister vos rappels actifs'))
  .addSubcommand((s) =>
    s
      .setName('supprimer')
      .setDescription('Supprimer un rappel')
      .addIntegerOption((o) =>
        o.setName('id').setDescription("ID du rappel").setRequired(true).setMinValue(1),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('pause')
      .setDescription('Mettre un rappel en pause')
      .addIntegerOption((o) =>
        o.setName('id').setDescription("ID du rappel").setRequired(true).setMinValue(1),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('reprendre')
      .setDescription('Reprendre un rappel en pause')
      .addIntegerOption((o) =>
        o.setName('id').setDescription("ID du rappel").setRequired(true).setMinValue(1),
      ),
  );

async function ephemeralError(
  interaction: ChatInputCommandInteraction,
  message: string,
): Promise<void> {
  const embeds = [buildErrorEmbed(message)];
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds });
  } else {
    await interaction.reply({ embeds, flags: MessageFlags.Ephemeral });
  }
}

export const rappelCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand(true);

    try {
      switch (sub) {
        case 'ajouter':
          await handleAjouter(interaction, ctx);
          break;
        case 'liste':
          await handleListe(interaction);
          break;
        case 'supprimer':
          await handleSupprimer(interaction, ctx);
          break;
        case 'pause':
          await handlePauseReprendre(interaction, ctx, true);
          break;
        case 'reprendre':
          await handlePauseReprendre(interaction, ctx, false);
          break;
        default:
          await ephemeralError(interaction, `Sous-commande inconnue : ${sub}`);
      }
    } catch (err) {
      logger.error({ err, sub }, 'command execution failed');
      const msg = err instanceof Error ? err.message : 'Erreur inconnue';
      await ephemeralError(interaction, msg);
    }
  },
};

async function handleAjouter(
  interaction: ChatInputCommandInteraction,
  ctx: { scheduler: import('../scheduler/scheduler').Scheduler },
): Promise<void> {
  const rawText = interaction.options.getString('texte', true);
  const quandKey = interaction.options.getString('quand', true);
  const quandPerso = interaction.options.getString('quand_personnalise') ?? '';
  const destinataire = interaction.options.getUser('destinataire');
  const couleurKey = interaction.options.getString('couleur') ?? 'bleu';

  const textParse = messageSchema.safeParse(rawText);
  if (!textParse.success) {
    await ephemeralError(interaction, 'Texte invalide (vide ou > 500 caractères).');
    return;
  }
  const texte = textParse.data;

  // Résolution de la planification
  let parsed: ParsedSchedule;
  let rawInput: string;
  try {
    if (quandKey === 'custom') {
      if (!quandPerso.trim()) {
        await ephemeralError(
          interaction,
          'Le champ « quand_personnalise » est requis quand vous choisissez « Personnalisé ».',
        );
        return;
      }
      parsed = parseFrenchSchedule(quandPerso);
      rawInput = quandPerso;
    } else {
      const preset = PRESET_BY_KEY.get(quandKey);
      if (!preset) {
        await ephemeralError(interaction, `Choix inconnu : ${quandKey}`);
        return;
      }
      parsed = preset.build(new Date());
      rawInput = preset.label;
    }
  } catch (err) {
    await ephemeralError(interaction, err instanceof Error ? err.message : 'Parse error');
    return;
  }

  const color = COLOR_BY_KEY.get(couleurKey)?.value ?? DEFAULT_COLOR;
  const nextRunAt =
    parsed.type === 'once' ? parsed.runAt : computeNextCronRun(parsed.cron, new Date());

  const inserted = await insertReminder({
    user_id: interaction.user.id,
    channel_id: interaction.channelId,
    guild_id: interaction.guildId,
    message: texte,
    schedule_type: parsed.type,
    cron_expression: parsed.type === 'recurring' ? parsed.cron : null,
    run_at: parsed.type === 'once' ? parsed.runAt.toISOString() : null,
    next_run_at: nextRunAt.toISOString(),
    raw_input: rawInput,
    is_last_day_of_month: parsed.type === 'recurring' && parsed.isLastDayOfMonth === true,
    color,
    target_user_id: destinataire?.id ?? null,
  });

  ctx.scheduler.schedule(inserted);

  await interaction.reply({
    embeds: [buildAddedEmbed(inserted, parsed.humanReadable)],
  });
}

const PAGE_SIZE = 10;

async function handleListe(interaction: ChatInputCommandInteraction): Promise<void> {
  const rows = await listRemindersByUser(interaction.user.id);
  if (rows.length <= PAGE_SIZE) {
    await interaction.reply({
      embeds: [buildListEmbed(rows, 0, PAGE_SIZE)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let page = 0;
  const totalPages = Math.ceil(rows.length / PAGE_SIZE);

  const makeRow = () =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('liste:prev')
        .setLabel('Précédent')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId('liste:next')
        .setLabel('Suivant')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
    );

  const msg = await interaction.reply({
    embeds: [buildListEmbed(rows, page, PAGE_SIZE)],
    components: [makeRow()],
    flags: MessageFlags.Ephemeral,
    withResponse: true,
  });

  const collector = msg.resource?.message?.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 120_000,
    filter: (i) => i.user.id === interaction.user.id,
  });

  collector?.on('collect', async (i) => {
    if (i.customId === 'liste:prev') page = Math.max(0, page - 1);
    else if (i.customId === 'liste:next') page = Math.min(totalPages - 1, page + 1);
    await i.update({
      embeds: [buildListEmbed(rows, page, PAGE_SIZE)],
      components: [makeRow()],
    });
  });

  collector?.on('end', async () => {
    try {
      await interaction.editReply({ components: [] });
    } catch {
      /* ignore */
    }
  });
}

async function handleSupprimer(
  interaction: ChatInputCommandInteraction,
  ctx: { scheduler: import('../scheduler/scheduler').Scheduler },
): Promise<void> {
  const id = interaction.options.getInteger('id', true);
  const row = await getReminderById(id);
  if (!row || row.user_id !== interaction.user.id) {
    await ephemeralError(interaction, `Aucun rappel #${id} ne vous appartient.`);
    return;
  }
  await deleteReminder(id);
  ctx.scheduler.unschedule(id);
  await interaction.reply({
    embeds: [buildSuccessEmbed('🗑️ Rappel supprimé', `Le rappel #${id} a été supprimé.`)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePauseReprendre(
  interaction: ChatInputCommandInteraction,
  ctx: { scheduler: import('../scheduler/scheduler').Scheduler },
  pause: boolean,
): Promise<void> {
  const id = interaction.options.getInteger('id', true);
  const row = await getReminderById(id);
  if (!row || row.user_id !== interaction.user.id) {
    await ephemeralError(interaction, `Aucun rappel #${id} ne vous appartient.`);
    return;
  }
  if (row.is_paused === pause) {
    await interaction.reply({
      embeds: [
        buildSuccessEmbed(
          pause ? '⏸️ Déjà en pause' : '▶️ Déjà actif',
          `Le rappel #${id} est déjà dans cet état.`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const updated = await setPaused(id, pause);
  if (!updated) {
    await ephemeralError(interaction, `Rappel #${id} introuvable.`);
    return;
  }
  if (pause) {
    ctx.scheduler.unschedule(id);
  } else {
    ctx.scheduler.schedule(updated);
  }
  await interaction.reply({
    embeds: [
      buildSuccessEmbed(
        pause ? '⏸️ Rappel en pause' : '▶️ Rappel repris',
        `Le rappel #${id} a été ${pause ? 'mis en pause' : 'repris'}.`,
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}
