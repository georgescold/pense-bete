import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Interaction,
  MessageFlags,
} from 'discord.js';
import { config } from './config';
import { logger } from './logger';
import { commandMap } from './commands';
import { handleWizardInteraction, isWizardInteraction } from './commands/wizard';
import { Scheduler } from './scheduler/scheduler';
import {
  deleteReminder,
  getReminderById,
  listAllActive,
  updateNextRunAt,
} from './db/repository';
import { computeNextCronRun } from './scheduler/scheduler';

async function main(): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
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

    if (interaction.isButton()) {
      const [namespace, action, idStr] = interaction.customId.split(':');
      if (namespace !== 'rappel') return;
      const id = Number.parseInt(idStr ?? '', 10);
      if (!Number.isFinite(id)) return;

      const r = await getReminderById(id);

      if (action === 'done') {
        // Les rappels ponctuels sont supprimés de la DB dès l'envoi (cf. fireReminder),
        // donc r peut être null ici — c'est attendu. On vérifie l'ownership uniquement
        // si le rappel existe encore.
        if (r) {
          const allowed =
            r.user_id === interaction.user.id || r.target_user_id === interaction.user.id;
          if (!allowed) {
            await interaction.reply({
              content: 'Ce rappel ne vous appartient pas.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          try {
            await deleteReminder(id);
          } catch {
            /* déjà supprimé */
          }
          scheduler.unschedule(id);
        }

        const originalEmbed = interaction.message.embeds[0];
        const reminderText = originalEmbed?.description ?? r?.message ?? '*(rappel)*';
        const originalColor = originalEmbed?.color ?? r?.color ?? 0x57f287;
        const validatedAt = Math.floor(Date.now() / 1000);

        const doneEmbed = new EmbedBuilder()
          .setColor(originalColor)
          .setTitle('✅ Rappel validé')
          .setDescription(reminderText)
          .addFields(
            { name: 'Validé par', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Validé le', value: `<t:${validatedAt}:F>`, inline: true },
          )
          .setFooter({ text: `Rappel #${id} · terminé` });

        await interaction.update({
          content: '',
          embeds: [doneEmbed],
          components: [],
          allowedMentions: { parse: [] },
        });
        return;
      }

      const allowed =
        r && (r.user_id === interaction.user.id || r.target_user_id === interaction.user.id);
      if (!r || !allowed) {
        await interaction.reply({
          content: 'Ce rappel ne vous appartient pas.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === 'skip' && r.schedule_type === 'recurring' && r.cron_expression) {
        const next = computeNextCronRun(r.cron_expression, new Date(Date.now() + 60_000));
        await updateNextRunAt(id, next);
        await interaction.update({
          content: `⏭️ Prochaine occurrence prévue : ${next.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`,
          embeds: [],
          components: [],
        });
        return;
      }
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
