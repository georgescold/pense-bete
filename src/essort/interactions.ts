import {
  ButtonInteraction,
  Interaction,
  MessageFlags,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { essortMembers } from '../config';
import { logger } from '../logger';
import {
  getBoardById,
  getSpan,
  getTask,
  listPlannedTasks,
  listTasks,
} from '../db/essortRepository';
import { addDays, compareTime, parseDayInput, parseTimeInput } from './planner';
import {
  answerSpan,
  carryAll,
  createSpan,
  crmActionAsTask,
  editSpan,
  editTask,
  essortToday,
  finishEvening,
  futureSpans,
  pendingCrmActions,
  planTask,
  refreshBoard,
  removeSpans,
  removeTasks,
  reportSpan,
  toggleCarry,
  toggleTasks,
  unplanTasks,
} from './service';
import { isSpanOpen, parseMomentInput, periodProblem, type Moment } from './spans';
import {
  buildEditModal,
  buildEditPickMenu,
  buildPeriodModal,
  buildPermanentModal,
  buildPlanDayMenu,
  buildRemoveMenu,
  buildSpanEditModal,
  buildSpanReportModal,
  buildTaskModal,
  buildUnplanMenu,
  dayLabel,
  dayOrder,
  PLAN_PERIOD,
  PLAN_PERMANENT,
  spanWhen,
  type EditableTask,
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

const MOMENT_HINT = 'écris par exemple **lundi 9h**, **demain 18h** ou **12/10 14h30**';

/**
 * Le début et la fin tapés dans le formulaire d'une période. Début vide :
 * maintenant. Renvoie le créneau, ou ce qui ne va pas.
 * @param kept début déjà enregistré (modification) : il peut être passé.
 */
function readPeriod(
  modal: ModalSubmitInteraction,
  kept?: Moment,
): { start: Moment; end: Moment } | string {
  const today = essortToday();
  const start = parseMomentInput(modal.fields.getTextInputValue('start'), today);
  const end = parseMomentInput(modal.fields.getTextInputValue('end'), today);
  if (start === undefined) return `Début illisible : ${MOMENT_HINT}.`;
  if (!end) return `Fin ${end === null ? 'manquante' : 'illisible'} : ${MOMENT_HINT}.`;
  const period = { start: start ?? { date: today, time: null }, end };
  return periodProblem(period.start, period.end, today, Date.now(), kept) ?? period;
}

/** Les valeurs d'un menu : tâches (`<id>`) et tâches sur plusieurs jours (`span:<id>`). */
function splitValues(values: string[]): { taskIds: number[]; spanIds: number[] } {
  const spanIds = values.filter((v) => v.startsWith('span:')).map((v) => Number(v.slice(5)));
  const taskIds = values.filter((v) => !v.startsWith('span:')).map(Number);
  return {
    taskIds: taskIds.filter(Number.isFinite),
    spanIds: spanIds.filter(Number.isFinite),
  };
}

/** La question de fin de période : elle ne dépend d'aucun tableau (`essort:span…:<id>`). */
const SPAN_ANSWERS = new Set(['spandone', 'spandrop', 'spanmore', 'spanmoremodal']);

async function handleSpanAnswer(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  action: string,
  spanId: number,
  by: string,
): Promise<void> {
  const messageId = interaction.message?.id ?? '';
  const span = await getSpan(spanId);
  if (!span || !isSpanOpen(span)) {
    // Déjà close depuis le tableau (cochée ou retirée) : la question le dit.
    await interaction.deferUpdate();
    if (span) await answerSpan(interaction.client, span.id, 'done', by, messageId);
    return;
  }

  switch (action) {
    case 'spandone':
    case 'spandrop': {
      await interaction.deferUpdate();
      await answerSpan(
        interaction.client,
        span.id,
        action === 'spandone' ? 'done' : 'drop',
        by,
        messageId,
      );
      return;
    }

    case 'spanmore': {
      await (interaction as ButtonInteraction).showModal(buildSpanReportModal(span, essortToday()));
      return;
    }

    case 'spanmoremodal': {
      const modal = interaction as ModalSubmitInteraction;
      const today = essortToday();
      const end = parseMomentInput(modal.fields.getTextInputValue('end'), today);
      const start = { date: span.start_date, time: span.start_time };
      const problem = !end
        ? `Fin illisible : ${MOMENT_HINT}.`
        : periodProblem(start, end, today, Date.now(), start);
      if (problem || !end) {
        await modal.reply({
          content: `Rien n’a été reporté. ${problem}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await modal.deferUpdate();
      await reportSpan(modal.client, span.id, end, by, messageId);
      return;
    }
  }
}

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

  const doneBy =
    essortMembers.find((m) => m.userId === interaction.user.id)?.person ??
    interaction.user.displayName;

  if (SPAN_ANSWERS.has(parsed.action) && !interaction.isStringSelectMenu()) {
    await handleSpanAnswer(interaction, parsed.action, parsed.boardId, doneBy);
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
      if (date === PLAN_PERMANENT) {
        await select.showModal(buildPermanentModal(board.id));
        return;
      }
      if (date === PLAN_PERIOD) {
        await select.showModal(buildPeriodModal(board.id));
        return;
      }
      if (!date || !ISO_DATE.test(date)) return;
      await select.showModal(buildTaskModal(board.id, date, 'plan'));
      return;
    }

    // Une tâche de tous les jours, ou sur une période.
    case 'permmodal':
    case 'periodmodal': {
      const modal = interaction as ModalSubmitInteraction;
      const label = modal.fields.getTextInputValue('label').replace(/\s+/g, ' ').trim();
      const period = parsed.action === 'periodmodal' ? readPeriod(modal) : null;
      const problem = !label
        ? 'Le texte de la tâche est vide.'
        : typeof period === 'string'
          ? period
          : null;
      if (problem || typeof period === 'string') {
        await modal.reply({
          content: `Tâche non enregistrée. ${problem}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await modal.deferUpdate();
      const span = await createSpan(modal.client, board, {
        kind: period ? 'period' : 'permanent',
        label,
        start: period?.start ?? { date: essortToday(), time: null },
        end: period?.end ?? null,
      });
      await modal.editReply({
        content: `📌 Planifié · ${spanWhen(span)} : ${label}`,
        components: [],
      });
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
      const spans = await futureSpans(board);
      if (planned.length + spans.length === 0) {
        await interaction.reply({
          content: 'Aucune tâche planifiée sur les jours à venir.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: 'Quelles tâches planifiées retirer ?',
        components: [buildUnplanMenu(board, planned, spans)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case 'unplanpick': {
      const select = interaction as StringSelectMenuInteraction;
      const { taskIds, spanIds } = splitValues(select.values);
      await select.update({ content: 'Retrait en cours…', components: [] });
      const removed = [
        ...(await unplanTasks(select.client, board, taskIds)),
        ...(await removeSpans(select.client, board, spanIds)),
      ];
      await select.editReply({ content: removedMessage(removed) });
      logger.info({ board: board.id, removed, by: doneBy }, 'taches planifiees retirees');
      return;
    }

    // --- Modifier une tâche (depuis le jour ou la semaine) ---------------------

    case 'edit':
    case 'wedit': {
      const fromWeek = parsed.action === 'wedit';
      // Depuis la semaine : les tâches posées sur les jours à venir, et les
      // actions du CRM de la semaine pas encore au planning (sans heure, le
      // plus souvent : c'est là qu'on veut en ajouter une).
      const items: EditableTask[] = fromWeek
        ? [
            ...(await listPlannedTasks(board.person, addDays(board.board_date, 1), '9999-12-31'))
              .filter((t) => !t.is_done)
              .map((task) => ({ task, date: task.essort_boards.board_date })),
            ...(await pendingCrmActions(board))
              .filter((u) => u.key)
              .map((u) => ({
                task: { id: 0, label: u.label, due_time: u.time },
                date: u.date,
                crmKey: u.key,
              })),
            ...(await futureSpans(board)).map((s) => ({
              task: { id: 0, label: s.label, due_time: s.start_time },
              date: s.start_date,
              spanId: s.id,
            })),
          ].sort(
            (a, b) => a.date.localeCompare(b.date) || compareTime(a.task.due_time, b.task.due_time),
          )
        : dayOrder(await listTasks(board.id))
            .filter((t) => !t.is_done)
            .map((task) => ({ task, date: board.board_date, spanId: task.span_id ?? undefined }));
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
      const value = select.values[0] ?? '';
      // Une tâche permanente ou une période se modifie entière.
      if (value.startsWith('span:')) {
        const span = await getSpan(Number(value.slice(5)));
        if (!span || !isSpanOpen(span)) {
          await select.update({
            content: 'Cette tâche n’existe plus ou est déjà faite.',
            components: [],
          });
          return;
        }
        await select.showModal(buildSpanEditModal(board.id, span));
        return;
      }
      // Une action du CRM devient d'abord une tâche de son jour.
      const fromCrm = value.startsWith('crm:')
        ? await crmActionAsTask(board, value.slice(4))
        : null;
      const task = fromCrm ? fromCrm.task : await getTask(Number(value));
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

    case 'spaneditmodal': {
      const modal = interaction as ModalSubmitInteraction;
      const span = await getSpan(Number(parsed.extra));
      const label = modal.fields.getTextInputValue('label').replace(/\s+/g, ' ').trim();
      const period =
        span?.kind === 'period'
          ? readPeriod(modal, { date: span.start_date, time: span.start_time })
          : null;
      const problem = !span
        ? 'La tâche n’existe plus.'
        : !label
          ? 'Le texte de la tâche est vide.'
          : typeof period === 'string'
            ? period
            : null;
      if (!span || problem || typeof period === 'string') {
        await modal.reply({
          content: `Rien n’a été modifié. ${problem}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await modal.deferUpdate();
      const updated = await editSpan(modal.client, board, span.id, {
        label,
        start: period?.start,
        end: period?.end,
      });
      await modal.editReply({
        content: updated
          ? `✏️ Modifié · ${spanWhen(updated)} : ${updated.label}`
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
