import { EmbedBuilder } from 'discord.js';
import parser from 'cron-parser';
import type { ReminderRow } from '../db/repository';
import { config } from '../config';
import { isLastDayOfMonthInParis } from '../scheduler/scheduler';
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

interface Occurrence {
  date: Date;
  reminder: ReminderRow;
}

const PARIS_TZ = 'Europe/Paris';
const DAY_KEY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PARIS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const DAY_LABEL_FMT = new Intl.DateTimeFormat('fr-FR', {
  timeZone: PARIS_TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const HOUR_FMT = new Intl.DateTimeFormat('fr-FR', {
  timeZone: PARIS_TZ,
  hour: '2-digit',
  minute: '2-digit',
});

function dayKey(d: Date): string {
  return DAY_KEY_FMT.format(d);
}

function dayLabel(d: Date): string {
  return DAY_LABEL_FMT.format(d);
}

function expandOccurrences(rows: ReminderRow[], from: Date, to: Date): Occurrence[] {
  const occs: Occurrence[] = [];
  for (const r of rows) {
    if (r.is_paused) continue;
    if (r.schedule_type === 'once') {
      const d = new Date(r.next_run_at);
      if (d >= from && d <= to) occs.push({ date: d, reminder: r });
      continue;
    }
    if (!r.cron_expression) continue;
    try {
      const interval = parser.parseExpression(r.cron_expression, {
        currentDate: from,
        endDate: to,
        tz: config.TIMEZONE,
      });
      let safety = 0;
      while (safety++ < 500) {
        try {
          const d = interval.next().toDate();
          if (r.is_last_day_of_month && !isLastDayOfMonthInParis(d)) continue;
          occs.push({ date: d, reminder: r });
        } catch {
          break;
        }
      }
    } catch {
      /* invalid cron, skip */
    }
  }
  occs.sort((a, b) => a.date.getTime() - b.date.getTime());
  return occs;
}

export function buildCalendarEmbed(rows: ReminderRow[], daysAhead: number): EmbedBuilder {
  const now = new Date();
  const to = new Date(now.getTime() + daysAhead * 86_400_000);
  const occs = expandOccurrences(rows, now, to);

  const embed = new EmbedBuilder()
    .setColor(BLURPLE)
    .setTitle(`📆 Calendrier — ${daysAhead} prochains jours`)
    .setFooter({ text: `${occs.length} occurrence(s) · heures en Europe/Paris` });

  if (occs.length === 0) {
    embed.setDescription(
      'Aucun rappel prévu sur cette période. Utilise `/rappel ajouter` pour en créer un.',
    );
    return embed;
  }

  const byDay = new Map<string, Occurrence[]>();
  for (const o of occs) {
    const k = dayKey(o.date);
    const arr = byDay.get(k);
    if (arr) arr.push(o);
    else byDay.set(k, [o]);
  }

  const todayKey = dayKey(now);
  const tomorrowKey = dayKey(new Date(now.getTime() + 86_400_000));

  const lines: string[] = [];
  let dropped = 0;
  for (const [key, dayOccs] of byDay) {
    const first = dayOccs[0]!.date;
    let header = `__**${dayLabel(first)}**__`;
    if (key === todayKey) header = `__**Aujourd'hui · ${dayLabel(first)}**__`;
    else if (key === tomorrowKey) header = `__**Demain · ${dayLabel(first)}**__`;

    const block: string[] = [header];
    for (const o of dayOccs) {
      const icon = o.reminder.schedule_type === 'recurring' ? '🔁' : '📅';
      const targetTag = o.reminder.target_user_id
        ? ` → <@${o.reminder.target_user_id}>`
        : '';
      block.push(
        `${icon} \`${HOUR_FMT.format(o.date)}\` · ${truncate(o.reminder.message, 80)} · #${o.reminder.id}${targetTag}`,
      );
    }
    const blockText = block.join('\n');
    const currentLen = lines.join('\n\n').length;
    if (currentLen + blockText.length + 2 > 3900) {
      dropped += dayOccs.length;
      continue;
    }
    lines.push(blockText);
  }

  let desc = lines.join('\n\n');
  if (dropped > 0) {
    desc += `\n\n*… +${dropped} occurrence(s) tronquées (utilise une période plus courte)*`;
  }
  embed.setDescription(desc);
  return embed;
}

export function buildErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setColor(RED).setTitle('❌ Erreur').setDescription(message);
}

export function buildSuccessEmbed(title: string, description?: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(GREEN).setTitle(title);
  if (description) e.setDescription(description);
  return e;
}
