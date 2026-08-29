import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { config, dailyEnabled } from '../config';
import { getPlan } from '../db/dailyRepository';
import { listTasks } from '../db/dailyRepository';
import { buildBoardEmbed } from '../daily/ui';
import { planDateFor, runBoardJob, runPrepJob, syncPendingPlans } from '../daily/service';
import type { Command } from './types';

const data = new SlashCommandBuilder()
  .setName('journee')
  .setDescription('Tes journées de travail (liste du soir, checklist du matin)')
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('preparer').setDescription('Préparer maintenant la liste de demain (comme à 18h)'),
  )
  .addSubcommand((s) =>
    s.setName('afficher').setDescription('Republier la checklist du jour (comme à 7h)'),
  )
  .addSubcommand((s) =>
    s.setName('recap').setDescription('Voir l’avancement de la journée en cours'),
  )
  .addSubcommand((s) =>
    s.setName('archiver').setDescription('Forcer l’archivage des journées en attente vers Sheets'),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!dailyEnabled) {
    await interaction.reply({
      content:
        '⚠️ Les journées de travail ne sont pas configurées (`DAILY_CHANNEL_ID` / `DAILY_USER_ID`).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'recap') {
    const plan = await getPlan(config.DAILY_USER_ID as string, planDateFor(0));
    if (!plan) {
      await interaction.reply({
        content: 'Aucune journée enregistrée pour aujourd’hui.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const tasks = await listTasks(plan.id);
    await interaction.reply({
      embeds: [buildBoardEmbed(plan, tasks)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === 'preparer') {
    await runPrepJob(interaction.client);
    await interaction.editReply('📝 Préparation de demain publiée dans le salon.');
    return;
  }

  if (sub === 'afficher') {
    await runBoardJob(interaction.client);
    await interaction.editReply('☀️ Checklist du jour publiée dans le salon.');
    return;
  }

  if (sub === 'archiver') {
    await syncPendingPlans();
    await interaction.editReply('📊 Archivage déclenché (voir les logs pour le détail).');
    return;
  }
}

export const journeeCommand: Command = { data, execute };
