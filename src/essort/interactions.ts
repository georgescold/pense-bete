import {
  ActionRowBuilder,
  ButtonInteraction,
  Interaction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { essortMembers } from '../config';
import { logger } from '../logger';
import { getBoardById, listTasks } from '../db/essortRepository';
import { addManualTask, refreshBoard, removeTasks, toggleTasks } from './service';
import { buildRemoveMenu } from './ui';

export function isEssortInteraction(customId: string): boolean {
  return customId.startsWith('essort:');
}

/** `essort:<action>:<boardId>[:<taskId>]` */
function parseId(customId: string): { action: string; boardId: number; extra?: string } | null {
  const [, action, rawBoardId, extra] = customId.split(':');
  const boardId = Number(rawBoardId);
  if (!action || !Number.isFinite(boardId)) return null;
  return { action, boardId, extra };
}

export async function handleEssortInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit())
    return;

  const parsed = parseId(interaction.customId);
  if (!parsed) return;

  // Seule l'équipe coche, dans n'importe lequel des deux salons : Loys peut
  // valider une tâche pour Enzo et inversement. Sans identifiants configurés,
  // personne n'est filtré.
  const team = essortMembers.map((m) => m.userId).filter((id): id is string => Boolean(id));
  if (team.length > 0 && !team.includes(interaction.user.id)) {
    await interaction.reply({
      content: 'Ce tableau est réservé à l’équipe Essort.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const board = await getBoardById(parsed.boardId);
  if (!board || board.archived_at) {
    await interaction.reply({
      content: 'Ce tableau est celui d’un jour passé : utilise celui d’aujourd’hui.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const doneBy =
    essortMembers.find((m) => m.userId === interaction.user.id)?.person ??
    interaction.user.displayName;

  switch (parsed.action) {
    case 'add': {
      await (interaction as ButtonInteraction).showModal(
        new ModalBuilder()
          .setCustomId(`essort:modaladd:${board.id}`)
          .setTitle('Nouvelle tâche')
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('label')
                .setLabel('Que faut-il faire ?')
                .setPlaceholder('Ex. : envoyer le devis à Atelier Martin')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(200)
                .setRequired(true),
            ),
          ),
      );
      return;
    }

    case 'modaladd': {
      const modal = interaction as ModalSubmitInteraction;
      const label = modal.fields.getTextInputValue('label').trim();
      await modal.deferUpdate();
      if (label) {
        await addManualTask(modal.client, board, label);
        logger.info({ board: board.id, label, by: doneBy }, 'tache Essort ajoutee');
      }
      return;
    }

    case 'toggle': {
      const taskId = Number(parsed.extra);
      await (interaction as ButtonInteraction).deferUpdate();
      if (Number.isFinite(taskId)) await toggleTasks(interaction.client, board, [taskId], doneBy);
      return;
    }

    // Repli au-delà de 20 tâches.
    case 'pick': {
      const select = interaction as StringSelectMenuInteraction;
      const ids = select.values.map(Number).filter(Number.isFinite);
      await select.deferUpdate();
      await toggleTasks(select.client, board, ids, doneBy);
      return;
    }

    case 'refresh': {
      await (interaction as ButtonInteraction).deferUpdate();
      await refreshBoard(interaction.client, board);
      return;
    }

    // 🗑️ : la liste des tâches s'ouvre pour la seule personne qui a cliqué.
    case 'remove': {
      const tasks = await listTasks(board.id);
      if (tasks.length === 0) {
        await interaction.reply({
          content: 'Aucune tâche à retirer.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: 'Quelles tâches retirer du tableau ?',
        components: [buildRemoveMenu(board, tasks)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case 'removepick': {
      const select = interaction as StringSelectMenuInteraction;
      const ids = select.values.map(Number).filter(Number.isFinite);
      await select.update({ content: 'Retrait en cours…', components: [] });
      const removed = await removeTasks(select.client, board, ids);
      await select.editReply({
        content:
          removed.length > 0
            ? `Retiré : ${removed.map((l) => `**${l}**`).join(', ')}`
            : 'Rien à retirer : la liste avait déjà changé.',
      });
      logger.info({ board: board.id, removed, by: doneBy }, 'taches Essort retirees');
      return;
    }

    default:
      logger.warn({ customId: interaction.customId }, 'action Essort inconnue');
  }
}
