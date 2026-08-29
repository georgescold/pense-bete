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
    s
      .setName('aujourdhui')
      .setDescription('Ouvrir la journée d’aujourd’hui et y ajouter des tâches'),
  )
  .addSubcommand((s) =>
    s.setName('demain').setDescription('Préparer la liste de demain (comme le message de 18h)'),
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
    await interaction.reply({ embeds: [buildBoardEmbed(plan, tasks)] });
    return;
  }

  // Le résultat de ces commandes est le message public posté dans le salon :
  // on supprime l'accusé de réception pour ne pas polluer la conversation.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === 'demain') {
    await runPrepJob(interaction.client);
    await interaction.deleteReply();
    return;
  }

  if (sub === 'aujourdhui') {
    // Ouverture manuelle : on ne déduit pas « repos », l'utilisateur vient
    // justement remplir sa journée.
    await runBoardJob(interaction.client, false);
    await interaction.deleteReply();
    return;
  }

  if (sub === 'archiver') {
    await syncPendingPlans();
    await interaction.editReply('📊 Archivage déclenché.');
    return;
  }
}

export const journeeCommand: Command = { data, execute };
