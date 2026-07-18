import type { Client, Message } from 'discord.js';
import { logger } from '../logger';
import type { ReminderRow } from '../db/repository';

/**
 * Épingle le message de récap dans le salon. Renvoie true si l'épinglage a
 * réussi (nécessite la permission « Gérer les messages »).
 */
export async function pinMessage(message: Message): Promise<boolean> {
  try {
    await message.pin();
    return true;
  } catch (err) {
    logger.warn({ err, messageId: message.id }, 'failed to pin reminder recap');
    return false;
  }
}

/** Dés-épingle le message de récap d'un rappel, si connu. Best-effort. */
export async function unpinReminder(client: Client, reminder: ReminderRow): Promise<void> {
  if (!reminder.pin_message_id) return;
  try {
    const channel = await client.channels.fetch(reminder.channel_id);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) return;
    const msg = await channel.messages.fetch(reminder.pin_message_id).catch(() => null);
    if (msg?.pinned) await msg.unpin();
  } catch (err) {
    logger.warn({ err, id: reminder.id }, 'failed to unpin reminder recap');
  }
}
