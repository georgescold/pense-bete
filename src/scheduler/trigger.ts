import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  TextChannel,
  NewsChannel,
  ThreadChannel,
  DMChannel,
} from 'discord.js';
import { logger } from '../logger';
import { buildReminderEmbed } from '../lib/embeds';
import { escalationDelayMs } from '../lib/datetime';
import { unpinReminder } from '../lib/pins';
import {
  deleteReminder,
  getReminderById,
  updateNextRunAt,
  updateReminder,
  type ReminderRow,
} from '../db/repository';
import { computeNextCronRun, Scheduler } from './scheduler';

type SendableChannel = TextChannel | NewsChannel | ThreadChannel | DMChannel;

function isSendable(ch: unknown): ch is SendableChannel {
  return (
    ch instanceof TextChannel ||
    ch instanceof NewsChannel ||
    ch instanceof ThreadChannel ||
    ch instanceof DMChannel
  );
}

/** Boutons affichés sous un rappel envoyé. */
export function buildReminderButtons(r: ReminderRow): ActionRowBuilder<ButtonBuilder> {
  if (r.schedule_type === 'recurring') {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`rappel:skip:${r.id}`)
        .setLabel('Skip prochaine')
        .setEmoji('⏭️')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rappel:done:${r.id}`)
      .setLabel('Fait')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
  );
  if (r.escalation_enabled) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`rappel:snooze:${r.id}`)
        .setLabel('Reporter')
        .setEmoji('😴')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`rappel:redef:${r.id}`)
        .setLabel('Redéfinir')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return row;
}

export async function fireReminder(
  client: Client,
  id: number,
  scheduler: Scheduler,
): Promise<void> {
  let reminder: ReminderRow | null;
  try {
    reminder = await getReminderById(id);
  } catch (err) {
    logger.error({ err, id }, 'fireReminder: failed to fetch reminder');
    return;
  }
  if (!reminder) {
    logger.warn({ id }, 'fireReminder: reminder no longer exists');
    scheduler.unschedule(id);
    return;
  }
  if (reminder.is_paused) {
    logger.debug({ id }, 'fireReminder: reminder is paused, skipping');
    return;
  }

  // Sur un rappel ponctuel, escalation_step > 0 signifie qu'il s'agit d'une
  // relance (le rappel n'a pas été validé lors des envois précédents).
  const isEscalation = reminder.schedule_type === 'once' && reminder.escalation_step > 0;

  try {
    const channel = await client.channels.fetch(reminder.channel_id);
    if (!isSendable(channel)) {
      logger.error(
        { id, channelId: reminder.channel_id },
        'fireReminder: channel not sendable',
      );
      return;
    }

    const mentionId = reminder.target_user_id ?? reminder.user_id;
    await channel.send({
      content: `<@${mentionId}>`,
      embeds: [buildReminderEmbed(reminder, isEscalation)],
      components: [buildReminderButtons(reminder)],
      allowedMentions: { users: [mentionId] },
    });
    logger.info({ id, isEscalation, step: reminder.escalation_step }, 'fired reminder');
  } catch (err) {
    logger.error({ err, id }, 'fireReminder: failed to send message');
  }

  // --- Post-envoi ---
  if (reminder.schedule_type === 'recurring') {
    if (reminder.cron_expression) {
      try {
        const next = computeNextCronRun(reminder.cron_expression, new Date());
        await updateNextRunAt(reminder.id, next);
      } catch (err) {
        logger.error({ err, id }, 'failed to update next_run_at');
      }
    }
    return;
  }

  // Ponctuel : soit on relance, soit on nettoie.
  if (!reminder.escalation_enabled) {
    await unpinReminder(client, reminder);
    try {
      await deleteReminder(reminder.id);
    } catch (err) {
      logger.error({ err, id }, 'failed to delete once reminder');
    }
    scheduler.unschedule(reminder.id);
    return;
  }

  // Relance activée : planifie le prochain rappel selon l'échelle.
  try {
    const delay = escalationDelayMs(reminder.escalation_step);
    const next = new Date(Date.now() + delay);
    const updated = await updateReminder(reminder.id, {
      status: 'awaiting_ack',
      escalation_step: reminder.escalation_step + 1,
      next_run_at: next.toISOString(),
    });
    if (updated) {
      scheduler.schedule(updated);
      logger.info(
        { id, nextStep: updated.escalation_step, fireAt: next.toISOString() },
        'scheduled escalation',
      );
    }
  } catch (err) {
    logger.error({ err, id }, 'failed to schedule escalation');
  }
}
