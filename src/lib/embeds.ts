import { EmbedBuilder } from 'discord.js';
import type { ReminderRow } from '../db/repository';
import { formatFrenchDate, truncate } from './format';

export const BLURPLE = 0x5865f2;
export const RED = 0xed4245;
export const GREEN = 0x57f287;
export const YELLOW = 0xfee75c;

export function buildAddedEmbed(r: ReminderRow, humanReadable: string): EmbedBuilder {
  const typeIcon = r.schedule_type === 'recurring' ? '🔁' : '📅';
  const embed = new EmbedBuilder()
    .setColor(r.color)
    .setTitle(`${typeIcon} Rappel enregistré`)
    .addFields(
      { name: 'ID', value: `\`${r.id}\``, inline: true },
      {
        name: 'Type',
        value: r.schedule_type === 'recurring' ? 'Récurrent' : 'Ponctuel',
        inline: true,
      },
      {
        name: 'Destinataire',
        value: `<@${r.target_user_id ?? r.user_id}>`,
        inline: true,
      },
      { name: 'Prochain déclenchement', value: formatFrenchDate(new Date(r.next_run_at)) },
      { name: 'Planification', value: humanReadable },
      { name: 'Message', value: truncate(r.message, 1000) },
    )
    .setTimestamp();
  return embed;
}

export function buildListEmbed(
  rows: ReminderRow[],
  page: number,
  pageSize: number,
): EmbedBuilder {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const start = page * pageSize;
  const slice = rows.slice(start, start + pageSize);

  const embed = new EmbedBuilder()
    .setColor(BLURPLE)
    .setTitle(`📋 Vos rappels (${rows.length})`)
    .setFooter({ text: `Page ${page + 1} / ${totalPages}` });

  if (slice.length === 0) {
    embed.setDescription('Aucun rappel actif. Utilisez `/rappel ajouter` pour en créer un.');
    return embed;
  }

  for (const r of slice) {
    const icon = r.is_paused ? '⏸️' : r.schedule_type === 'recurring' ? '🔁' : '📅';
    const statut = r.is_paused ? ' (en pause)' : '';
    embed.addFields({
      name: `${icon} #${r.id}${statut}`,
      value: `**${truncate(r.message, 50)}**\n→ ${formatFrenchDate(new Date(r.next_run_at))}\n*${r.raw_input}*`,
    });
  }
  return embed;
}

export function buildReminderEmbed(r: ReminderRow): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(r.color)
    .setTitle('🔔 Rappel')
    .setDescription(r.message)
    .setFooter({ text: `ID: ${r.id}` })
    .setTimestamp();
}

export function buildErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setColor(RED).setTitle('❌ Erreur').setDescription(message);
}

export function buildSuccessEmbed(title: string, description?: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(GREEN).setTitle(title);
  if (description) e.setDescription(description);
  return e;
}
