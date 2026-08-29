import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import type { DailyTaskRow, DayPlanRow } from '../db/dailyRepository';
import { truncate } from '../lib/format';

const COLOR_PREP = 0xf1c40f; // ambre : on prépare
const COLOR_BOARD = 0x5865f2; // bleu : journée en cours
const COLOR_CLOSED = 0x2ecc71; // vert : journée clôturée

/** Un menu déroulant Discord accepte au maximum 25 options. */
const MAX_OPTIONS = 25;

/** 'YYYY-MM-DD' → 'samedi 30 août 2026' */
export function formatPlanDate(planDate: string): string {
  const [y, m, d] = planDate.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
  return date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function taskLine(task: DailyTaskRow, index: number): string {
  const box = task.is_done ? '☑' : '☐';
  const label = task.is_done ? `~~${task.label}~~` : task.label;
  const tag = task.carried_over ? ' *(reportée)*' : '';
  return `${box} **${index + 1}.** ${label}${tag}`;
}

function progressBar(done: number, total: number): string {
  if (total === 0) return '';
  const slots = 12;
  const filled = Math.round((done / total) * slots);
  return `\`${'█'.repeat(filled)}${'░'.repeat(slots - filled)}\` ${done}/${total}`;
}

// ---------------------------------------------------------------------------
// Message du soir : préparation de la journée du lendemain
// ---------------------------------------------------------------------------

export function buildPrepEmbed(
  plan: DayPlanRow,
  tasks: DailyTaskRow[],
  pending: DailyTaskRow[],
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLOR_PREP)
    .setTitle(`📝 Demain — ${formatPlanDate(plan.plan_date)}`)
    .setDescription(
      tasks.length > 0
        ? truncate(tasks.map((t, i) => taskLine(t, i)).join('\n'), 4000)
        : '_Aucune tâche pour l’instant. Clique sur « ➕ Ajouter une tâche »._',
    );

  if (pending.length > 0) {
    embed.addFields({
      name: `⏭️ Non terminé aujourd’hui (${pending.length})`,
      value: truncate(pending.map((t) => `• ${t.label}`).join('\n'), 1000),
    });
  }

  embed.setFooter({ text: 'Ta liste sera présentée demain à 7h, prête à cocher.' });
  return embed;
}

export function buildPrepComponents(
  plan: DayPlanRow,
  pending: DailyTaskRow[],
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (pending.length > 0) {
    const options = pending.slice(0, MAX_OPTIONS);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`daily:carry:${plan.id}`)
      .setPlaceholder('⏭️ Reporter à demain…')
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(
        options.map((t) =>
          new StringSelectMenuOptionBuilder()
            .setValue(String(t.id))
            .setLabel(truncate(t.label, 100)),
        ),
      );
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<
        ButtonBuilder | StringSelectMenuBuilder
      >,
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`daily:add:${plan.id}`)
        .setLabel('Ajouter une tâche')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`daily:undo:${plan.id}`)
        .setLabel('Retirer la dernière')
        .setEmoji('↩️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`daily:ready:${plan.id}`)
        .setLabel('Ma liste est prête')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
    ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Message du matin : la checklist de la journée
// ---------------------------------------------------------------------------

export function buildBoardEmbed(plan: DayPlanRow, tasks: DailyTaskRow[]): EmbedBuilder {
  const done = tasks.filter((t) => t.is_done).length;
  const closed = plan.status === 'closed';
  const embed = new EmbedBuilder()
    .setColor(closed ? COLOR_CLOSED : COLOR_BOARD)
    .setTitle(`${closed ? '🏁' : '☀️'} ${formatPlanDate(plan.plan_date)}`)
    .setDescription(
      tasks.length > 0
        ? truncate(tasks.map((t, i) => taskLine(t, i)).join('\n'), 4000)
        : '_Aucune tâche prévue pour aujourd’hui._',
    );

  if (tasks.length > 0) {
    embed.addFields({ name: 'Avancement', value: progressBar(done, tasks.length) });
  }
  embed.setFooter({
    text: closed ? 'Journée clôturée et archivée.' : 'Coche tes tâches au fil de la journée.',
  });
  return embed;
}

export function buildBoardComponents(
  plan: DayPlanRow,
  tasks: DailyTaskRow[],
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  if (plan.status === 'closed') return [];
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  const options = tasks.slice(0, MAX_OPTIONS);
  if (options.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`daily:toggle:${plan.id}`)
      .setPlaceholder('✅ Cocher / décocher une tâche…')
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(
        options.map((t) =>
          new StringSelectMenuOptionBuilder()
            .setValue(String(t.id))
            .setLabel(truncate(t.label, 100))
            .setEmoji(t.is_done ? '☑️' : '⬜'),
        ),
      );
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<
        ButtonBuilder | StringSelectMenuBuilder
      >,
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`daily:add:${plan.id}`)
        .setLabel('Ajouter une tâche')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`daily:close:${plan.id}`)
        .setLabel('Clôturer la journée')
        .setEmoji('🏁')
        .setStyle(ButtonStyle.Success),
    ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
  );
  return rows;
}
