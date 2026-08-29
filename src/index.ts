import {
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  MessageFlags,
} from 'discord.js';
import { config, dailyEnabled } from './config';
import { logger } from './logger';
import { commandMap } from './commands';
import { handleWizardInteraction, isWizardInteraction } from './commands/wizard';
import { handleReminderComponent, isReminderComponent } from './commands/reminderActions';
import { handleDailyInteraction, isDailyInteraction } from './daily/interactions';
import { startDailyJobs } from './daily/jobs';
import { buildHelpEmbed } from './lib/embeds';
import { Scheduler } from './scheduler/scheduler';
import { listAllActive, updateNextRunAt } from './db/repository';
import { computeNextCronRun } from './scheduler/scheduler';

async function main(): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
    ],
  });

  const scheduler = new Scheduler(client);

  client.once(Events.ClientReady, async (c) => {
    logger.info({ tag: c.user.tag }, '🤖 bot connecté');
    try {
      const active = await listAllActive();
      // Pour les rappels ponctuels dont l'heure est passée pendant le downtime,
      // on les déclenche immédiatement (puis ils seront supprimés par fireReminder).
      // Pour les récurrents en retard, on avance next_run_at avant de planifier.
      const now = new Date();
      for (const r of active) {
        const nextRun = new Date(r.next_run_at);
        if (r.schedule_type === 'recurring' && r.cron_expression && nextRun.getTime() < now.getTime()) {
          try {
            const fresh = computeNextCronRun(r.cron_expression, now);
            await updateNextRunAt(r.id, fresh);
            r.next_run_at = fresh.toISOString();
          } catch (err) {
            logger.error({ err, id: r.id }, 'failed to recompute next_run_at on reload');
          }
        }
        scheduler.schedule(r);
      }
      logger.info({ count: active.length, scheduled: scheduler.size() }, '⏰ rappels rechargés');
    } catch (err) {
      logger.error({ err }, 'failed to reload reminders on startup');
    }

    if (dailyEnabled) {
      startDailyJobs(client);
    } else {
      logger.info('journées de travail désactivées (DAILY_CHANNEL_ID / DAILY_USER_ID absents)');
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isChatInputCommand()) {
      const cmd = commandMap.get(interaction.commandName);
      if (!cmd) {
        await interaction.reply({
          content: `Commande inconnue : ${interaction.commandName}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      try {
        await cmd.execute(interaction, { scheduler });
      } catch (err) {
        logger.error({ err, cmd: interaction.commandName }, 'unhandled command error');
        const msg = err instanceof Error ? err.message : 'Erreur inconnue';
        const payload = {
          content: `❌ ${msg}`,
          flags: MessageFlags.Ephemeral as const,
        };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload).catch(() => undefined);
        } else {
          await interaction.reply(payload).catch(() => undefined);
        }
      }
      return;
    }

    if (
      (interaction.isStringSelectMenu() ||
        interaction.isUserSelectMenu() ||
        interaction.isModalSubmit() ||
        interaction.isButton()) &&
      isWizardInteraction(interaction.customId)
    ) {
      try {
        await handleWizardInteraction(interaction, scheduler);
      } catch (err) {
        logger.error({ err, customId: interaction.customId }, 'wizard interaction failed');
        const msg = err instanceof Error ? err.message : 'Erreur inconnue';
        try {
          if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
          } else if (interaction.isRepliable()) {
            await interaction.followUp({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
          }
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (
      (interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        interaction.isModalSubmit()) &&
      isDailyInteraction(interaction.customId)
    ) {
      try {
        await handleDailyInteraction(interaction);
      } catch (err) {
        logger.error({ err, customId: interaction.customId }, 'daily interaction failed');
        const msg = err instanceof Error ? err.message : 'Erreur inconnue';
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
          } else {
            await interaction.followUp({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
          }
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (
      (interaction.isButton() || interaction.isStringSelectMenu()) &&
      isReminderComponent(interaction.customId)
    ) {
      try {
        await handleReminderComponent(interaction, scheduler);
      } catch (err) {
        logger.error({ err, customId: interaction.customId }, 'reminder component failed');
        const msg = err instanceof Error ? err.message : 'Erreur inconnue';
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
          } else {
            await interaction.followUp({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
          }
        } catch {
          /* ignore */
        }
      }
      return;
    }
  });

  // Mentionner le bot (@) affiche l'aide. Discord fournit le contenu/les mentions
  // des messages qui mentionnent le bot, même sans l'intent MessageContent privilégié.
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot) return;
      if (message.mentions.everyone) return;
      if (!client.user || !message.mentions.users.has(client.user.id)) return;
      await message.reply({
        embeds: [buildHelpEmbed()],
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      logger.warn({ err }, 'failed to reply to mention with help');
    }
  });

  client.on(Events.Error, (err) => logger.error({ err }, 'discord client error'));

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down…');
    client.destroy().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await client.login(config.DISCORD_TOKEN);
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
