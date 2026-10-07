import type { Client } from 'discord.js';
import { logger } from '../logger';

/**
 * Signal « les rappels de cette personne ont changé » (création, pause,
 * suppression…). Les rappels n'ont pas à connaître ceux qui les affichent :
 * le planning Essort s'abonne ici pour se mettre à jour.
 */
type Listener = (client: Client, userId: string) => Promise<void> | void;

const listeners: Listener[] = [];

export function onRemindersChanged(listener: Listener): void {
  listeners.push(listener);
}

export function remindersChanged(client: Client, userId: string): void {
  for (const listener of listeners) {
    Promise.resolve()
      .then(() => listener(client, userId))
      .catch((err) => logger.warn({ err, userId }, 'mise a jour apres changement de rappel'));
  }
}
