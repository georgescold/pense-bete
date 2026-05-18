import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { logger } from '../logger';
import {
  deleteReminder,
  getReminderById,
  listRemindersByUser,
  setPaused,
} from '../db/repository';
import {
  buildCalendarEmbed,
  buildErrorEmbed,
  buildListEmbed,
  buildSuccessEmbed,
} from '../lib/embeds';
import { startWizard } from './wizard';
import type { Command } from './types';

const data = new SlashCommandBuilder()
  .setName('rappel')
  .setDescription('Gérer vos rappels (pense-bête)')
  .setDMPermission(true)
  .addSubcommand((s) =>
    s.setName('ajouter').setDescription('Ouvrir le formulaire pour créer un rappel'),
  )
  .addSubcommand((s) => s.setName('liste').setDescription('Lister vos rappels actifs'))
  .addSubcommand((s) =>
    s
      .setName('calendrier')
      .setDescription('Vue calendrier des rappels à venir')
      .addIntegerOption((o) =>
        o
          .setName('jours')
          .setDescription('Nombre de jours à afficher (1-60, défaut 30)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(60),
      ),
  )
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
          await startWizard(interaction);
          break;
        case 'liste':
          await handleListe(interaction);
          break;
        case 'calendrier':
          await handleCalendrier(interaction);
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

async function handleCalendrier(interaction: ChatInputCommandInteraction): Promise<void> {
  const days = interaction.options.getInteger('jours') ?? 30;
  const rows = await listRemindersByUser(interaction.user.id);
  await interaction.reply({
    embeds: [buildCalendarEmbed(rows, days)],
    flags: MessageFlags.Ephemeral,
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
