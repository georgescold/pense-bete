import {
  ButtonInteraction,
  Interaction,
  MessageFlags,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { essortMembers } from '../config';
import { logger } from '../logger';
import { getBoardById, getTask, listPlannedTasks, listTasks } from '../db/essortRepository';
import { addDays, parseDayInput, parseTimeInput } from './planner';
import {
  carryAll,
  editTask,
  essortToday,
  finishEvening,
  planTask,
  refreshBoard,
  removeTasks,
  toggleCarry,
  toggleTasks,
  unplanTasks,
} from './service';
import {
  buildEditModal,
  buildEditPickMenu,
  buildPlanDayMenu,
  buildRemoveMenu,
  buildTaskModal,
  buildUnplanMenu,
  dayLabel,
  dayOrder,
} from './ui';

export function isEssortInteraction(customId: string): boolean {
  return customId.startsWith('essort:');
}

/** `essort:<action>:<boardId>[:<taskId | date>]` */
function parseId(customId: string): { action: string; boardId: number; extra?: string } | null {
  const [, action, rawBoardId, extra] = customId.split(':');
  const boardId = Number(rawBoardId);
  if (!action || !Number.isFinite(boardId)) return null;
  return { action, boardId, extra };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function removedMessage(removed: string[]): string {
  return removed.length > 0
    ? `Retiré : ${removed.map((l) => `**${l}**`).join(', ')}`
    : 'Rien à retirer : la liste avait déjà changé.';
}

export async function handleEssortInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit())
    return;

  const parsed = parseId(interaction.customId);
  if (!parsed) return;

  // Seule l'équipe agit, dans n'importe lequel des deux salons : Loys peut
  // valider ou planifier pour Enzo et inversement.
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
    // --- Message du jour ----------------------------------------------------

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

    case 'add': {
      await (interaction as ButtonInteraction).showModal(
        buildTaskModal(board.id, board.board_date, 'add'),
      );
      return;
    }

    case 'remove': {
      const tasks = dayOrder(await listTasks(board.id));
      if (tasks.length === 0) {
        await interaction.reply({
          content: 'Aucune tâche à retirer.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: 'Quelles tâches retirer d’aujourd’hui ?',
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
      await select.editReply({ content: removedMessage(removed) });
      logger.info({ board: board.id, removed, by: doneBy }, 'taches Essort retirees');
      return;
    }

    // --- Message de la semaine ----------------------------------------------

    case 'plan': {
      await interaction.reply({
        content: 'Pour quel jour ?',
        components: [buildPlanDayMenu(board)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case 'planday': {
      const select = interaction as StringSelectMenuInteraction;
      const date = select.values[0];
      if (!date || !ISO_DATE.test(date)) return;
      await select.showModal(buildTaskModal(board.id, date, 'plan'));
      return;
    }

    // Saisie validée, depuis le jour (« addmodal ») ou la semaine (« planmodal »).
    case 'addmodal':
    case 'planmodal': {
      const modal = interaction as ModalSubmitInteraction;
      const date = parsed.extra ?? '';
      const label = modal.fields.getTextInputValue('label').replace(/\s+/g, ' ').trim();
      const time = parseTimeInput(modal.fields.getTextInputValue('time'));
      if (!ISO_DATE.test(date) || date < essortToday() || !label) {
        await modal.reply({
          content: 'Tâche non enregistrée : jour passé ou texte vide.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (time === undefined) {
        await modal.reply({
          content: 'Heure illisible : écris par exemple **14h30**, **9h** ou **14:30**.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await modal.deferUpdate();
      await planTask(modal.client, board, date, label, time);
      // Depuis la semaine, la réponse s'affiche dans le menu éphémère ; depuis
      // le jour, le tableau mis à jour suffit.
      if (parsed.action === 'planmodal') {
        await modal.editReply({
          content: `📌 Planifié · **${dayLabel(date)}**${time ? ` à **${time}**` : ''} : ${label}`,
          components: [],
        });
      }
      return;
    }

    case 'unplan': {
      const planned = await listPlannedTasks(
        board.person,
        addDays(board.board_date, 1),
        '9999-12-31',
      );
      if (planned.length === 0) {
        await interaction.reply({
          content: 'Aucune tâche planifiée sur les jours à venir.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: 'Quelles tâches planifiées retirer ?',
        components: [buildUnplanMenu(board, planned)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case 'unplanpick': {
      const select = interaction as StringSelectMenuInteraction;
      const ids = select.values.map(Number).filter(Number.isFinite);
      await select.update({ content: 'Retrait en cours…', components: [] });
      const removed = await unplanTasks(select.client, board, ids);
      await select.editReply({ content: removedMessage(removed) });
      logger.info({ board: board.id, removed, by: doneBy }, 'taches planifiees retirees');
      return;
    }

    // --- Modifier une tâche (depuis le jour ou la semaine) ---------------------

    case 'edit':
    case 'wedit': {
      const fromWeek = parsed.action === 'wedit';
      const items = fromWeek
        ? (await listPlannedTasks(board.person, addDays(board.board_date, 1), '9999-12-31'))
            .filter((t) => !t.is_done)
            .map((task) => ({ task, date: task.essort_boards.board_date }))
        : dayOrder(await listTasks(board.id))
            .filter((t) => !t.is_done)
            .map((task) => ({ task, date: board.board_date }));
      if (items.length === 0) {
        await interaction.reply({
          content: fromWeek
            ? 'Aucune tâche planifiée sur les jours à venir. Les actions du CRM se modifient dans Airtable.'
            : 'Aucune tâche à modifier aujourd’hui.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: 'Quelle tâche modifier ?',
        components: [buildEditPickMenu(board, items, fromWeek)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case 'editpick': {
      const select = interaction as StringSelectMenuInteraction;
      const task = await getTask(Number(select.values[0]));
      const taskBoard = task ? await getBoardById(task.board_id) : null;
      if (!task || !taskBoard || task.dismissed_at || task.is_done) {
        await select.update({
          content: 'Cette tâche n’existe plus ou est déjà faite.',
          components: [],
        });
        return;
      }
      await select.showModal(buildEditModal(board.id, task, taskBoard.board_date));
      return;
    }

    case 'editmodal': {
      const modal = interaction as ModalSubmitInteraction;
      const taskId = Number(parsed.extra);
      const label = modal.fields.getTextInputValue('label').replace(/\s+/g, ' ').trim();
      const date = parseDayInput(modal.fields.getTextInputValue('day'), essortToday());
      const time = parseTimeInput(modal.fields.getTextInputValue('time'));
      const problem = !label
        ? 'Le texte de la tâche est vide.'
        : !date
          ? 'Jour illisible : écris par exemple **demain**, **lundi** ou **12/10**.'
          : date < essortToday()
            ? 'Ce jour est déjà passé.'
            : time === undefined
              ? 'Heure illisible : écris par exemple **14h30**, **9h** ou **14:30**.'
              : null;
      if (problem || !date || time === undefined) {
        await modal.reply({
          content: `Rien n’a été modifié. ${problem}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await modal.deferUpdate();
      const done = await editTask(modal.client, board, taskId, { label, date, time });
      await modal.editReply({
        content: done
          ? `✏️ Modifié · **${dayLabel(date)}**${time ? ` à **${time}**` : ''} : ${label}`
          : 'Rien n’a été modifié : la tâche n’existe plus ou est déjà faite.',
        components: [],
      });
      return;
    }

    case 'refresh': {
      await (interaction as ButtonInteraction).deferUpdate();
      await refreshBoard(interaction.client, board);
      return;
    }

    // --- Question de 19h ----------------------------------------------------

    // Un clic sur un numéro : reporte la tâche, ou annule son report. La
    // question reste ouverte pour en reporter d'autres.
    case 'carrytoggle': {
      const taskId = Number(parsed.extra);
      await (interaction as ButtonInteraction).deferUpdate();
      if (Number.isFinite(taskId)) await toggleCarry(interaction.client, board, [taskId]);
      return;
    }

    // Repli au-delà de 20 tâches (et anciens messages à menu).
    case 'carry': {
      const select = interaction as StringSelectMenuInteraction;
      const ids = select.values.map(Number).filter(Number.isFinite);
      await select.deferUpdate();
      await toggleCarry(select.client, board, ids);
      return;
    }

    case 'carryall': {
      await (interaction as ButtonInteraction).deferUpdate();
      await carryAll(interaction.client, board, doneBy);
      return;
    }

    // « Terminé » (et « Ne rien reporter » des anciens messages).
    case 'carrydone':
    case 'carrynone': {
      await (interaction as ButtonInteraction).deferUpdate();
      await finishEvening(interaction.client, board, doneBy);
      return;
    }

    default:
      logger.warn({ customId: interaction.customId }, 'action Essort inconnue');
  }
}
