import { REST, Routes } from 'discord.js';
import { config } from '../config';
import { commands } from '../commands';
import { logger } from '../logger';

async function main(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
  const body = commands.map((c) => c.data.toJSON());

  if (config.GUILD_ID) {
    logger.info({ guildId: config.GUILD_ID }, 'deploying guild commands (instant)');
    await rest.put(Routes.applicationGuildCommands(config.CLIENT_ID, config.GUILD_ID), {
      body,
    });
  } else {
    logger.info('deploying global commands (peut prendre ~1h pour se propager)');
    await rest.put(Routes.applicationCommands(config.CLIENT_ID), { body });
  }
  logger.info({ count: body.length }, '✅ commands deployed');
}

main().catch((err) => {
  logger.error({ err }, 'deploy-commands failed');
  process.exit(1);
});
