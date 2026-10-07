import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  Interaction,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import {
  deleteReminder,
  getReminderById,
  listRemindersByUser,
  setPaused,
  type ReminderRow,
} from '../db/repository';
import { buildRecapEmbed } from '../lib/embeds';
import { truncate } from '../lib/format';
import { unpinReminder } from '../lib/pins';
import { remindersChanged } from '../lib/reminderEvents';
import type { Scheduler } from '../scheduler/scheduler';
import { startWizard } from './wizard';

/**
 * Panneau « ⏰ Rappels » ouvert depuis un bouton (planning Essort) : la liste
 * de ses rappels et tout ce qu'il faut pour les gérer, sans retenir de
 * commande ni d'identifiant. Visible de la seule personne qui a cliqué.
 *
 *   rpanel:open           → la liste
 *   rpanel:new            → formulaire de création (le même que /rappel ajouter)
 *   rpanel:pick           → un rappel choisi, avec ses boutons
 *   rpanel:pause:<id>     ⏸️   rpanel:resume:<id> ▶️   rpanel:delete:<id> 🗑️
 *   rpanel:back           → retour à la liste
 */

export function isReminderPanelInteraction(customId: string): boolean {
  return customId.startsWith('rpanel:');
}

async function activeReminders(userId: string): Promise<ReminderRow[]> {
  return (await listRemindersByUser(userId)).filter((r) => r.status !== 'done');
}

function whenText(r: ReminderRow): string {
  const next = new Date(r.next_run_at).toLocaleString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: config.TIMEZONE,
  });
  return r.schedule_type === 'recurring' ? `${r.raw_input} · prochain : ${next}` : next;
}

/** Même contenu pour une première réponse ou une mise à jour du panneau. */
interface View {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}

function listView(rows: ReminderRow[], note?: string): View {
  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  if (rows.length > 0) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('rpanel:pick')
          .setPlaceholder('Modifier, mettre en pause ou supprimer un rappel…')
          .addOptions(
            rows.slice(0, 25).map((r) =>
              new StringSelectMenuOptionBuilder()
                .setValue(String(r.id))
                .setLabel(truncate(`${r.is_paused ? '⏸️ ' : ''}${r.message}`, 100))
                .setDescription(truncate(whenText(r), 100)),
            ),
          ),
      ),
    );
  }
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('rpanel:new')
        .setLabel('Nouveau rappel')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary),
    ),
  );
  return { content: note ?? '', embeds: [buildRecapEmbed(rows)], components };
}

function detailView(r: ReminderRow): View {
  const embed = new EmbedBuilder()
    .setColor(r.color)
    .setTitle(`⏰ ${truncate(r.message, 240)}`)
    .addFields(
      { name: 'Quand', value: truncate(whenText(r), 1000) },
      { name: 'État', value: r.is_paused ? '⏸️ En pause' : '▶️ Actif', inline: true },
      {
        name: 'Type',
        value: r.schedule_type === 'recurring' ? '🔁 Récurrent' : '📅 Une fois',
        inline: true,
      },
    );
  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(
        r.is_paused
          ? new ButtonBuilder()
              .setCustomId(`rpanel:resume:${r.id}`)
              .setLabel('Réactiver')
              .setEmoji('▶️')
              .setStyle(ButtonStyle.Success)
          : new ButtonBuilder()
              .setCustomId(`rpanel:pause:${r.id}`)
              .setLabel('Mettre en pause')
              .setEmoji('⏸️')
              .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`rpanel:delete:${r.id}`)
          .setLabel('Supprimer')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('rpanel:back')
          .setLabel('Retour')
          .setEmoji('↩️')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

/** Un rappel appartient à celui qui l'a créé : personne d'autre n'y touche. */
async function ownReminder(id: number, userId: string): Promise<ReminderRow | null> {
  const row = Number.isFinite(id) ? await getReminderById(id) : null;
  return row && row.user_id === userId ? row : null;
}

export async function handleReminderPanel(
  interaction: Interaction,
  scheduler: Scheduler,
): Promise<void> {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
  const [, action, rawId] = interaction.customId.split(':');
  const userId = interaction.user.id;

  switch (action) {
    case 'open': {
      await interaction.reply({
        ...listView(await activeReminders(userId)),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case 'new': {
      await startWizard(interaction as ButtonInteraction);
      return;
    }

    case 'back': {
      await interaction.update(listView(await activeReminders(userId)));
      return;
    }

    case 'pick': {
      const select = interaction as StringSelectMenuInteraction;
      const row = await ownReminder(Number(select.values[0]), userId);
      await select.update(
        row ? detailView(row) : listView(await activeReminders(userId), 'Ce rappel n’existe plus.'),
      );
      return;
    }

    case 'pause':
    case 'resume': {
      const row = await ownReminder(Number(rawId), userId);
      if (!row) {
        await interaction.update(
          listView(await activeReminders(userId), 'Ce rappel n’existe plus.'),
        );
        return;
      }
      const pause = action === 'pause';
      const updated = row.is_paused === pause ? row : await setPaused(row.id, pause);
      if (updated) {
        if (pause) scheduler.unschedule(updated.id);
        else scheduler.schedule(updated);
      }
      remindersChanged(interaction.client, userId);
      logger.info({ id: row.id, pause }, 'rappel mis a jour depuis le panneau');
      await interaction.update(detailView(updated ?? row));
      return;
    }

    case 'delete': {
      const row = await ownReminder(Number(rawId), userId);
      if (row) {
        await unpinReminder(interaction.client, row);
        await deleteReminder(row.id);
        scheduler.unschedule(row.id);
        remindersChanged(interaction.client, userId);
        logger.info({ id: row.id }, 'rappel supprime depuis le panneau');
      }
      await interaction.update(
        listView(
          await activeReminders(userId),
          row ? `🗑️ Supprimé : **${truncate(row.message, 200)}**` : 'Ce rappel n’existe plus.',
        ),
      );
      return;
    }

    default:
      logger.warn({ customId: interaction.customId }, 'action du panneau de rappels inconnue');
  }
}
