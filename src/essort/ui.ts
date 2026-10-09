import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { EssortBoardRow, EssortTaskRow, TaskWithBoard } from '../db/essortRepository';
import { truncate } from '../lib/format';
import { addDays, compareTime, shortDate, WEEK_DAYS, weekdayName, type CrmAction } from './planner';

/**
 * Deux messages par personne et par jour, dans cet ordre :
 *  1. « Ta semaine » : les 6 jours suivants (pas aujourd'hui), pour voir venir
 *     et planifier ;
 *  2. « Aujourd'hui » : seulement ce qu'il y a à faire, à cocher.
 */

const COLOR_DAY = 0x5865f2; // bleu : journée en cours
const COLOR_DONE = 0x57f287; // vert : tout est fait
const COLOR_WEEK = 0xfaa61a; // ambre : ce qui arrive
const COLOR_ARCHIVED = 0x4f545c; // gris : jour passé

const BUTTONS_PER_ROW = 5;
/** 4 lignes de boutons + 1 ligne d'actions = les 5 lignes autorisées par Discord. */
const MAX_TASK_BUTTONS = 20;
/** Au-delà, 3 lignes de boutons et le reste dans un menu (25 options max). */
const BUTTONS_BEFORE_SELECT = 15;
const MAX_OPTIONS = 25;
/** Place réservée à une liste : un embed entier ne peut dépasser 6 000 caractères. */
const LIST_BUDGET = 3500;
const FIELD_BUDGET = 900;

type Row = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** 'YYYY-MM-DD' → 'Jeudi 08/10'. */
export function dayLabel(date: string): string {
  return `${capitalize(weekdayName(date))} ${shortDate(date)}`;
}

function withTime(time: string | null, text: string): string {
  return time ? `${time} · ${text}` : text;
}

function progressBar(done: number, total: number): string {
  const slots = 10;
  const filled = total === 0 ? 0 : Math.round((done / total) * slots);
  return `${'▰'.repeat(filled)}${'▱'.repeat(slots - filled)}  **${done}/${total}**`;
}

// ---------------------------------------------------------------------------
// Aujourd'hui
// ---------------------------------------------------------------------------

/**
 * Ordre de la journée : les heures fixes d'abord, puis l'ordre d'arrivée.
 * Les numéros des boutons suivent cet ordre : toujours passer par ici.
 */
export function dayOrder(tasks: EssortTaskRow[]): EssortTaskRow[] {
  return [...tasks].sort(
    (a, b) => compareTime(a.due_time, b.due_time) || a.position - b.position || a.id - b.id,
  );
}

/** Heure en `code` devant le texte : même repère visuel dans le jour et la semaine. */
function timed(time: string | null, text: string): string {
  return time ? `\`${time}\` ${text}` : text;
}

/**
 * Une tâche : « 1. » (le numéro du bouton) et son titre en gras, puis sa
 * consigne en texte simple sur la ligne suivante. Pas de liste Markdown : une
 * puce sous la tâche se lisait comme une tâche de plus.
 */
function taskLine(t: EssortTaskRow, position: number, withDetails: boolean): string {
  if (t.is_done) return `~~${position}. ${t.due_time ? `${t.due_time} ` : ''}${t.label}~~`;
  const sub =
    withDetails && t.details
      ? `
${t.details}`
      : '';
  return `**${position}.** ${timed(t.due_time, `**${t.label}**`)}${sub}`;
}

/** Les détails s'effacent sur les dernières tâches si la liste déborde. */
function taskLines(tasks: EssortTaskRow[]): string {
  const lines: string[] = [];
  let used = 0;
  let detailed = true;
  tasks.forEach((t, i) => {
    let line = taskLine(t, i + 1, detailed);
    if (detailed && used + line.length + 1 > LIST_BUDGET) {
      detailed = false;
      line = taskLine(t, i + 1, false);
    }
    lines.push(line);
    used += line.length + 1;
  });
  return truncate(lines.join('\n'), LIST_BUDGET);
}

/** Au-dessus du message du jour : la personne est toujours mentionnée. */
export function dayIntro(mention: string | null, remaining: number, total: number): string {
  const who = mention ? `${mention} ` : '';
  if (total === 0) return `${who}Rien de prévu aujourd’hui.`;
  if (remaining === 0) return `${who}Tout est fait aujourd’hui. ✅`;
  return `${who}${remaining === 1 ? '1 tâche' : `${remaining} tâches`} aujourd’hui.`;
}

export interface TimedLine {
  time: string | null;
  label: string;
}

/**
 * @param tasks déjà dans l'ordre de `dayOrder`.
 * @param reminders rappels du jour (ils se déclenchent seuls, rien à cocher ici).
 */
export function buildDayEmbed(
  board: EssortBoardRow,
  tasks: EssortTaskRow[],
  reminders: TimedLine[] = [],
): EmbedBuilder {
  const done = tasks.filter((t) => t.is_done).length;
  const archived = Boolean(board.archived_at);
  const allDone = tasks.length > 0 && done === tasks.length;

  const embed = new EmbedBuilder()
    .setColor(archived ? COLOR_ARCHIVED : allDone ? COLOR_DONE : COLOR_DAY)
    .setTitle(`${archived ? '🏁' : '☀️'} Aujourd’hui · ${dayLabel(board.board_date)}`)
    .setDescription(
      tasks.length === 0
        ? 'Rien de prévu.'
        : `${progressBar(done, tasks.length)}\n​\n${taskLines(tasks)}`,
    );

  if (reminders.length > 0) {
    embed.addFields({
      name: '⏰ Rappels',
      value: truncate(reminders.map((r) => `- ${timed(r.time, r.label)}`).join('\n'), FIELD_BUDGET),
    });
  }
  if (board.extras?.airtableError && !archived) {
    embed.addFields({
      name: '⚠️ Airtable injoignable',
      value: 'La liste peut être incomplète, nouvelle lecture à la prochaine actualisation.',
    });
  }
  return embed;
}

export function buildDayComponents(board: EssortBoardRow, tasks: EssortTaskRow[]): Row[] {
  if (board.archived_at) return [];
  const rows: Row[] = [];

  const overflow = tasks.length > MAX_TASK_BUTTONS;
  const withButtons = tasks.slice(0, overflow ? BUTTONS_BEFORE_SELECT : MAX_TASK_BUTTONS);
  for (let i = 0; i < withButtons.length; i += BUTTONS_PER_ROW) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        withButtons.slice(i, i + BUTTONS_PER_ROW).map((t, j) =>
          new ButtonBuilder()
            .setCustomId(`essort:toggle:${board.id}:${t.id}`)
            .setLabel(String(i + j + 1))
            .setEmoji(t.is_done ? '✅' : '✔️')
            .setStyle(t.is_done ? ButtonStyle.Success : ButtonStyle.Primary),
        ),
      ) as Row,
    );
  }

  if (overflow) {
    const rest = tasks.slice(BUTTONS_BEFORE_SELECT, BUTTONS_BEFORE_SELECT + MAX_OPTIONS);
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`essort:pick:${board.id}`)
          .setPlaceholder(`Valider une tâche ${BUTTONS_BEFORE_SELECT + 1}+…`)
          .setMinValues(1)
          .setMaxValues(rest.length)
          .addOptions(
            rest.map((t, i) =>
              new StringSelectMenuOptionBuilder()
                .setValue(String(t.id))
                .setLabel(
                  truncate(
                    `${t.is_done ? '✓ ' : ''}${BUTTONS_BEFORE_SELECT + i + 1}. ${t.label}`,
                    100,
                  ),
                ),
            ),
          ),
      ) as Row,
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`essort:add:${board.id}`)
        .setLabel('Ajouter')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`essort:remove:${board.id}`)
        .setLabel('Retirer')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(tasks.length === 0),
    ) as Row,
  );
  return rows;
}

/** Menu « que retirer ? » du jour, visible de la seule personne qui a cliqué. */
export function buildRemoveMenu(
  board: EssortBoardRow,
  tasks: EssortTaskRow[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = tasks.slice(0, MAX_OPTIONS);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`essort:removepick:${board.id}`)
      .setPlaceholder('Tâches à retirer…')
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(
        options.map((t, i) =>
          new StringSelectMenuOptionBuilder()
            .setValue(String(t.id))
            .setLabel(truncate(`${i + 1}. ${withTime(t.due_time, t.label)}`, 100))
            .setDescription(
              t.source === 'airtable'
                ? 'Ne reviendra pas tant que le lead ne change pas dans Airtable'
                : 'Ajoutée à la main',
            ),
        ),
      ),
  );
}

// ---------------------------------------------------------------------------
// La semaine
// ---------------------------------------------------------------------------

export type WeekItemKind = 'airtable' | 'planned' | 'reminder';

export interface WeekItem {
  date: string;
  time: string | null;
  label: string;
  kind: WeekItemKind;
}

function weekItemText(item: WeekItem): string {
  return `- ${timed(item.time, item.kind === 'reminder' ? `${item.label} (rappel)` : item.label)}`;
}

/** Les 6 jours qui suivent le tableau, un bloc par jour, même vide. */
export function buildWeekEmbed(board: EssortBoardRow, items: WeekItem[]): EmbedBuilder {
  const days = Array.from({ length: WEEK_DAYS }, (_, i) => addDays(board.board_date, i + 1));
  const blocks = days.map((date) => {
    const lines = items
      .filter((it) => it.date === date)
      .sort((a, b) => compareTime(a.time, b.time))
      .map(weekItemText);
    return `**${dayLabel(date)}**\n${lines.length > 0 ? lines.join('\n') : '*Rien de prévu*'}`;
  });
  const first = days[0]!;
  const last = days[days.length - 1]!;

  return new EmbedBuilder()
    .setColor(board.archived_at ? COLOR_ARCHIVED : COLOR_WEEK)
    .setTitle(
      `📅 Ta semaine · ${weekdayName(first, true)} ${shortDate(first)} → ${weekdayName(last, true)} ${shortDate(last)}`,
    )
    .setDescription(truncate(blocks.join('\n\n'), 4000));
}

export function buildWeekComponents(board: EssortBoardRow, plannedCount: number): Row[] {
  if (board.archived_at) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`essort:plan:${board.id}`)
        .setLabel('Planifier')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`essort:unplan:${board.id}`)
        .setLabel('Retirer')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(plannedCount === 0),
      new ButtonBuilder()
        .setCustomId('rpanel:open')
        .setLabel('Rappels')
        .setEmoji('⏰')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`essort:refresh:${board.id}`)
        .setLabel('Actualiser')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary),
    ) as Row,
  ];
}

/** Choix du jour à planifier : aujourd'hui et les 24 jours suivants. */
export function buildPlanDayMenu(board: EssortBoardRow): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`essort:planday:${board.id}`)
      .setPlaceholder('Quel jour ?')
      .addOptions(
        Array.from({ length: MAX_OPTIONS }, (_, i) => {
          const date = addDays(board.board_date, i);
          const label =
            i === 0
              ? `Aujourd’hui (${shortDate(date)})`
              : i === 1
                ? `Demain (${shortDate(date)})`
                : dayLabel(date);
          return new StringSelectMenuOptionBuilder().setValue(date).setLabel(label);
        }),
      ),
  );
}

/**
 * Saisie d'une tâche : le texte, et une heure facultative (ping à l'heure).
 * @param from 'plan' depuis la semaine (réponse dans le menu éphémère),
 * 'add' depuis le message du jour (le tableau se met à jour, rien d'autre).
 */
export function buildTaskModal(boardId: number, date: string, from: 'plan' | 'add'): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`essort:${from}modal:${boardId}:${date}`)
    .setTitle(from === 'add' ? 'Ajouter pour aujourd’hui' : `Planifier · ${dayLabel(date)}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('label')
          .setLabel('Que faut-il faire ?')
          .setPlaceholder('Ex. : envoyer le devis à Atelier Martin')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(200)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('time')
          .setLabel('À quelle heure ? (facultatif)')
          .setPlaceholder('Ex. : 14h30 — le bot te pingue à l’heure')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(5)
          .setRequired(false),
      ),
    );
}

/** Menu des tâches planifiées à retirer (jours à venir). */
export function buildUnplanMenu(
  board: EssortBoardRow,
  planned: TaskWithBoard[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = planned.slice(0, MAX_OPTIONS);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`essort:unplanpick:${board.id}`)
      .setPlaceholder('Tâches planifiées à retirer…')
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(
        options.map((t) =>
          new StringSelectMenuOptionBuilder()
            .setValue(String(t.id))
            .setLabel(truncate(withTime(t.due_time, t.label), 100))
            .setDescription(dayLabel(t.essort_boards.board_date)),
        ),
      ),
  );
}

// ---------------------------------------------------------------------------
// 19h : « Reporter à demain ? »
// ---------------------------------------------------------------------------

export interface EveningMessage {
  content: string;
  embeds: EmbedBuilder[];
  components: Row[];
}

/** Une tâche de la question du soir : encore sur le jour, ou déjà reportée. */
export interface EveningItem {
  task: EssortTaskRow;
  carried: boolean;
}

/**
 * Les tâches non faites du jour, une par bouton numéroté : un clic la reporte
 * à demain, un second annule. On en reporte autant qu'on veut, puis
 * « Terminé ». Rien n'est reporté sans clic : elles restent sur le jour.
 */
export function buildEveningMessage(
  board: EssortBoardRow,
  items: EveningItem[],
  mention: string | null,
): EveningMessage {
  const count = items.length === 1 ? 'Il reste 1 tâche' : `Il reste ${items.length} tâches`;
  const lines = items.map(
    ({ task, carried }, i) =>
      `**${i + 1}.** ${timed(task.due_time, task.label)}${carried ? ' → **demain**' : ''}`,
  );

  const rows: Row[] = [];
  // Comme le message du jour : 20 boutons au plus, le reste dans un menu.
  const overflow = items.length > MAX_TASK_BUTTONS;
  const withButtons = items.slice(0, overflow ? BUTTONS_BEFORE_SELECT : MAX_TASK_BUTTONS);
  for (let i = 0; i < withButtons.length; i += BUTTONS_PER_ROW) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        withButtons.slice(i, i + BUTTONS_PER_ROW).map(({ task, carried }, j) =>
          new ButtonBuilder()
            .setCustomId(`essort:carrytoggle:${board.id}:${task.id}`)
            .setLabel(carried ? `${i + j + 1} → demain` : String(i + j + 1))
            .setStyle(carried ? ButtonStyle.Success : ButtonStyle.Secondary),
        ),
      ) as Row,
    );
  }
  if (overflow) {
    const rest = items.slice(BUTTONS_BEFORE_SELECT, BUTTONS_BEFORE_SELECT + MAX_OPTIONS);
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`essort:carry:${board.id}`)
          .setPlaceholder(`Reporter ou annuler ${BUTTONS_BEFORE_SELECT + 1}+…`)
          .setMinValues(1)
          .setMaxValues(rest.length)
          .addOptions(
            rest.map(({ task, carried }, i) =>
              new StringSelectMenuOptionBuilder()
                .setValue(String(task.id))
                .setLabel(
                  truncate(
                    `${BUTTONS_BEFORE_SELECT + i + 1}. ${withTime(task.due_time, task.label)}${carried ? ' → demain' : ''}`,
                    100,
                  ),
                ),
            ),
          ),
      ) as Row,
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`essort:carryall:${board.id}`)
        .setLabel('Tout reporter')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`essort:carrydone:${board.id}`)
        .setLabel('Terminé')
        .setStyle(ButtonStyle.Success),
    ) as Row,
  );

  return {
    content: `${mention ? `${mention} ` : ''}${count} aujourd’hui. Lesquelles reporter à demain ?`,
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR_WEEK)
        .setTitle(`🌙 Ce soir · ${dayLabel(board.board_date)}`)
        .setDescription(truncate(lines.join('\n'), LIST_BUDGET))
        .setFooter({ text: 'Un clic sur un numéro le reporte, un second annule.' }),
    ],
    components: rows,
  };
}

/** Ce qui reste de la question une fois close. */
export function eveningSummary(carried: string[], answered: boolean): string {
  if (carried.length > 0) return `Reporté à demain : ${carried.map((l) => `**${l}**`).join(', ')}`;
  return answered
    ? 'Rien n’a été reporté : les tâches restent sur aujourd’hui.'
    : 'Sans réponse : rien n’a été reporté.';
}

// ---------------------------------------------------------------------------
// Ce que le bot a compris d'une mise à jour du CRM
// ---------------------------------------------------------------------------

/**
 * Une ligne par action ajoutée ou déplacée dans le CRM : le jour, l'heure et
 * la tâche telles que le bot les a comprises. Rien à cocher ici : la tâche
 * arrive dans le message du jour le moment venu.
 */
export function crmUpdateMessage(changes: CrmAction[], today: string): string {
  const lines = changes.map((a) => {
    const when =
      a.date < today
        ? `En retard (prévu le ${shortDate(a.date)})`
        : a.date === today
          ? 'Aujourd’hui'
          : a.date === addDays(today, 1)
            ? 'Demain'
            : dayLabel(a.date);
    return `- ${when} · ${timed(a.time, a.label)}`;
  });
  return truncate(`Agenda mis à jour depuis le CRM :\n${lines.join('\n')}`, 1900);
}
