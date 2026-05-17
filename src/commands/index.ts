import { rappelCommand } from './rappel';
import type { Command } from './types';

export const commands: Command[] = [rappelCommand];

export const commandMap = new Map<string, Command>(commands.map((c) => [c.data.name, c]));
