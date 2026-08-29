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
import { config } from '../config';
import { logger } from '../logger';
import {
  addTask,
  deleteTask,
  getPlanById,
  listTasks,
  listTasksByIds,
  setTaskDone,
  type DailyTaskRow,
} from '../db/dailyRepository';
import { closePlan, refreshPlanMessages } from './service';

export function isDailyInteraction(customId: string): boolean {
  return customId.startsWith('daily:');
}

/** `daily:<action>:<planId>[:<extra>]` */
function parseId(customId: string): { action: string; planId: number; extra?: string } | null {
  const [, action, rawPlanId, extra] = customId.split(':');
  const planId = Number(rawPlanId);
  if (!action || !Number.isFinite(planId)) return null;
  return { action, planId, extra };
}

export async function handleDailyInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit())
    return;

  const parsed = parseId(interaction.customId);
  if (!parsed) return;

  // Bot personnel : seul le propriétaire manipule ses listes.
  if (config.DAILY_USER_ID && interaction.user.id !== config.DAILY_USER_ID) {
    await interaction.reply({
      content: 'Cette liste n’est pas la tienne.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const plan = await getPlanById(parsed.planId);
  if (!plan) {
    await interaction.reply({
      content: 'Cette journée n’existe plus.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  switch (parsed.action) {
    // Seul cas qui ouvre une fenêtre : la saisie d'une nouvelle tâche.
    case 'add': {
      await (interaction as ButtonInteraction).showModal(
        new ModalBuilder()
          .setCustomId(`daily:modaladd:${plan.id}`)
          .setTitle('Nouvelle tâche')
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('label')
                .setLabel('Que dois-tu faire ?')
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
        await addTask(plan.id, label);
        await refreshPlanMessages(modal.client, plan);
        logger.info({ id: plan.id, label }, 'tache ajoutee');
      }
      return;
    }

    case 'undo': {
      const tasks = await listTasks(plan.id);
      const last = tasks[tasks.length - 1];
      await (interaction as ButtonInteraction).deferUpdate();
      if (last) {
        await deleteTask(last.id);
        await refreshPlanMessages(interaction.client, plan);
      }
      return;
    }

    // Un clic sur le numéro d'une tâche : coche ou décoche immédiatement.
    case 'toggle': {
      const taskId = Number(parsed.extra);
      await (interaction as ButtonInteraction).deferUpdate();
      if (!Number.isFinite(taskId)) return;
      const [task] = await listTasksByIds([taskId]);
      if (!task) return;
      await setTaskDone(task.id, !task.is_done);
      await refreshPlanMessages(interaction.client, plan);
      return;
    }

    // Repli pour les journées de plus de 20 tâches.
    case 'pick': {
      const select = interaction as StringSelectMenuInteraction;
      const ids = select.values.map(Number).filter(Number.isFinite);
      await select.deferUpdate();
      const tasks = await listTasksByIds(ids);
      for (const task of tasks) await setTaskDone(task.id, !task.is_done);
      await refreshPlanMessages(select.client, plan);
      return;
    }

    case 'carry': {
      const select = interaction as StringSelectMenuInteraction;
      const ids = select.values.map(Number).filter(Number.isFinite);
      await select.deferUpdate();
      // On relit les libellés en base plutôt que de faire confiance au menu.
      const sources = new Map<number, DailyTaskRow>();
      for (const t of await listTasksByIds(ids)) sources.set(t.id, t);
      for (const id of ids) {
        const source = sources.get(id);
        if (source) await addTask(plan.id, source.label, true);
      }
      await refreshPlanMessages(select.client, plan);
      return;
    }

    case 'close': {
      await (interaction as ButtonInteraction).deferUpdate();
      await closePlan(interaction.client, plan);
      logger.info({ id: plan.id }, 'journee cloturee manuellement');
      return;
    }

    default:
      logger.warn({ customId: interaction.customId }, 'action daily inconnue');
  }
}
