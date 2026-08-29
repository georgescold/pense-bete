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

/** 'daily:add:12' → { action: 'add', planId: 12 } */
function parseId(customId: string): { action: string; planId: number } | null {
  const parts = customId.split(':');
  // daily:<action>:<planId> ou daily:modal:<action>:<planId>
  const action = parts[1] === 'modal' ? `modal:${parts[2]}` : parts[1];
  const planId = Number(parts[parts.length - 1]);
  if (!action || !Number.isFinite(planId)) return null;
  return { action, planId };
}

async function ephemeral(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

export async function handleDailyInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit())
    return;

  const parsed = parseId(interaction.customId);
  if (!parsed) return;

  // Bot personnel : seul le propriétaire des journées manipule ses listes.
  if (config.DAILY_USER_ID && interaction.user.id !== config.DAILY_USER_ID) {
    await ephemeral(interaction, "Cette liste n'est pas la tienne.");
    return;
  }

  const plan = await getPlanById(parsed.planId);
  if (!plan) {
    await ephemeral(interaction, 'Cette journée n’existe plus.');
    return;
  }

  switch (parsed.action) {
    case 'add': {
      const modal = new ModalBuilder()
        .setCustomId(`daily:modal:add:${plan.id}`)
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
        );
      await (interaction as ButtonInteraction).showModal(modal);
      return;
    }

    case 'modal:add': {
      const modalInteraction = interaction as ModalSubmitInteraction;
      const label = modalInteraction.fields.getTextInputValue('label').trim();
      if (!label) {
        await ephemeral(modalInteraction, 'Tâche vide, rien ajouté.');
        return;
      }
      await addTask(plan.id, label);
      await modalInteraction.deferUpdate();
      await refreshPlanMessages(modalInteraction.client, plan);
      await modalInteraction.followUp({
        content: `➕ **${label}** ajoutée.`,
        flags: MessageFlags.Ephemeral,
      });
      logger.info({ id: plan.id, label }, 'tache ajoutee');
      return;
    }

    case 'undo': {
      const tasks = await listTasks(plan.id);
      const last = tasks[tasks.length - 1];
      if (!last) {
        await ephemeral(interaction, 'Il n’y a aucune tâche à retirer.');
        return;
      }
      await deleteTask(last.id);
      await (interaction as ButtonInteraction).deferUpdate();
      await refreshPlanMessages(interaction.client, plan);
      await interaction.followUp({
        content: `↩️ **${last.label}** retirée.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case 'ready': {
      const tasks = await listTasks(plan.id);
      await (interaction as ButtonInteraction).deferUpdate();
      await interaction.followUp({
        content:
          tasks.length > 0
            ? `✅ Liste prête : **${tasks.length}** tâche(s). Rendez-vous demain à 7h.`
            : 'Ta liste est vide — tu peux encore ajouter des tâches jusqu’à demain matin.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case 'carry': {
      const select = interaction as StringSelectMenuInteraction;
      const ids = select.values.map(Number).filter(Number.isFinite);
      // Les tâches proposées viennent de la journée précédente : on relit leurs
      // libellés depuis la base plutôt que de faire confiance au menu.
      const sourceTasks = new Map<number, DailyTaskRow>();
      for (const t of await listTasksByIds(ids)) sourceTasks.set(t.id, t);

      let added = 0;
      for (const id of ids) {
        const source = sourceTasks.get(id);
        if (!source) continue;
        await addTask(plan.id, source.label, true);
        added += 1;
      }
      await select.deferUpdate();
      await refreshPlanMessages(select.client, plan);
      await select.followUp({
        content: `⏭️ ${added} tâche(s) reportée(s).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case 'toggle': {
      const select = interaction as StringSelectMenuInteraction;
      const ids = select.values.map(Number).filter(Number.isFinite);
      const tasks = await listTasks(plan.id);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      for (const id of ids) {
        const task = byId.get(id);
        if (!task) continue;
        await setTaskDone(task.id, !task.is_done);
      }
      await select.deferUpdate();
      await refreshPlanMessages(select.client, plan);
      return;
    }

    case 'close': {
      await (interaction as ButtonInteraction).deferUpdate();
      const closed = await closePlan(interaction.client, plan);
      const tasks = await listTasks(closed.id);
      const done = tasks.filter((t) => t.is_done).length;
      await interaction.followUp({
        content: `🏁 Journée clôturée — **${done}/${tasks.length}** fait. Archivage en cours.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    default:
      logger.warn({ customId: interaction.customId }, 'action daily inconnue');
  }
}
