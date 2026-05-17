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
import {
  deleteReminder,
  getReminderById,
  updateNextRunAt,
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

  try {
    const channel = await client.channels.fetch(reminder.channel_id);
    if (!isSendable(channel)) {
      logger.error(
        { id, channelId: reminder.channel_id },
        'fireReminder: channel not sendable',
      );
      return;
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      reminder.schedule_type === 'once'
        ? new ButtonBuilder()
            .setCustomId(`rappel:done:${reminder.id}`)
            .setLabel('Fait')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success)
        : new ButtonBuilder()
            .setCustomId(`rappel:skip:${reminder.id}`)
            .setLabel('Skip prochaine')
            .setEmoji('⏭️')
            .setStyle(ButtonStyle.Secondary),
    );

    const mentionId = reminder.target_user_id ?? reminder.user_id;
    await channel.send({
      content: `<@${mentionId}>`,
      embeds: [buildReminderEmbed(reminder)],
      components: [row],
      allowedMentions: { users: [mentionId] },
    });
    logger.info({ id }, 'fired reminder');
  } catch (err) {
    logger.error({ err, id }, 'fireReminder: failed to send message');
  }

  // Post-send bookkeeping
  if (reminder.schedule_type === 'once') {
    try {
      await deleteReminder(reminder.id);
    } catch (err) {
      logger.error({ err, id }, 'failed to delete once reminder');
    }
    scheduler.unschedule(reminder.id);
  } else if (reminder.cron_expression) {
    try {
      const next = computeNextCronRun(reminder.cron_expression, new Date());
      await updateNextRunAt(reminder.id, next);
    } catch (err) {
      logger.error({ err, id }, 'failed to update next_run_at');
    }
  }
}
