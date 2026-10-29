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
import type {
  EssortBoardRow,
  EssortSpanRow,
  EssortTaskRow,
  TaskWithBoard,
} from '../db/essortRepository';
import { truncate } from '../lib/format';
import { addDays, compareTime, shortDate, WEEK_DAYS, weekdayName, type CrmAction } from './planner';
import { DEFAULT_END_TIME, periodText, teamText } from './spans';

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
 * @param carried tâches reportées au lendemain depuis ce jour : elles ne sont
 * plus à cocher ici, mais restent visibles pour qu'on sache où elles sont.
 */
export function buildDayEmbed(
  board: EssortBoardRow,
  tasks: EssortTaskRow[],
  reminders: TimedLine[] = [],
  carried: EssortTaskRow[] = [],
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

  if (carried.length > 0) {
    embed.addFields({
      name: archived ? 'Reporté au lendemain' : 'Reporté à demain',
      value: truncate(
        carried.map((t) => `- ${timed(t.due_time, t.label)}`).join('\n'),
        FIELD_BUDGET,
      ),
    });
  }
  if (reminders.length > 0) {
    embed.addFields({
      name: '⏰ Rappels',
      value: truncate(reminders.map((r) => `- ${timed(r.time, r.label)}`).join('\n'), FIELD_BUDGET),
    });
  }
  if (board.extras?.crmError && !archived) {
    embed.addFields({
      name: '⚠️ CRM injoignable',
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
        .setCustomId(`essort:edit:${board.id}`)
        .setLabel('Modifier')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!tasks.some((t) => !t.is_done)),
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
              t.span_id
                ? 'Retirée aussi des jours suivants'
                : t.record_id?.startsWith('tache:')
                  ? 'Supprimée aussi du calendrier du CRM'
                  : t.source === 'airtable'
                    ? 'Ne reviendra pas tant que la fiche ne change pas dans le CRM'
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

/**
 * @param plannedCount tâches posées sur les jours à venir (« Retirer »)
 * @param editableCount celles-ci plus les actions du CRM à venir (« Modifier »)
 */
export function buildWeekComponents(
  board: EssortBoardRow,
  plannedCount: number,
  editableCount = plannedCount,
): Row[] {
  if (board.archived_at) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`essort:plan:${board.id}`)
        .setLabel('Planifier')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`essort:wedit:${board.id}`)
        .setLabel('Modifier')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(editableCount === 0),
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

/** Valeurs du menu « Pour quand ? » qui ne sont pas un jour. */
export const PLAN_PERMANENT = 'permanent';
export const PLAN_PERIOD = 'period';

/**
 * Choix de quand planifier : tous les jours (jusqu'à être faite), sur une
 * période, ou un jour précis (aujourd'hui et les 22 jours suivants).
 */
export function buildPlanDayMenu(board: EssortBoardRow): ActionRowBuilder<StringSelectMenuBuilder> {
  const special = [
    new StringSelectMenuOptionBuilder()
      .setValue(PLAN_PERMANENT)
      .setLabel('Tous les jours, jusqu’à ce qu’elle soit faite')
      .setDescription('Revient chaque jour tant qu’elle n’est pas cochée'),
    new StringSelectMenuOptionBuilder()
      .setValue(PLAN_PERIOD)
      .setLabel('Sur une période')
      .setDescription('Du jour et de l’heure de début à ceux de fin'),
  ];
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`essort:planday:${board.id}`)
      .setPlaceholder('Pour quand ?')
      .addOptions(
        ...special,
        ...Array.from({ length: MAX_OPTIONS - special.length }, (_, i) => {
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

/**
 * Menu des tâches planifiées à retirer (jours à venir), et des périodes qui
 * n'ont pas encore commencé (valeur `span:<id>`).
 */
export function buildUnplanMenu(
  board: EssortBoardRow,
  planned: TaskWithBoard[],
  spans: EssortSpanRow[] = [],
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = [
    ...planned.map((t) =>
      new StringSelectMenuOptionBuilder()
        .setValue(String(t.id))
        .setLabel(truncate(withTime(t.due_time, t.label), 100))
        .setDescription(dayLabel(t.essort_boards.board_date)),
    ),
    ...spans.map((s) =>
      new StringSelectMenuOptionBuilder()
        .setValue(`span:${s.id}`)
        .setLabel(truncate(s.label, 100))
        .setDescription(truncate(capitalize(periodText(s)), 100)),
    ),
  ].slice(0, MAX_OPTIONS);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`essort:unplanpick:${board.id}`)
      .setPlaceholder('Tâches planifiées à retirer…')
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(options),
  );
}

// ---------------------------------------------------------------------------
// Tâches permanentes et périodes
// ---------------------------------------------------------------------------

function labelInput(value?: string): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId('label')
    .setLabel('Que faut-il faire ?')
    .setPlaceholder('Ex. : préparer la présentation de lundi')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(200)
    .setRequired(true);
  if (value !== undefined) input.setValue(truncate(value, 200));
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function momentInput(id: 'start' | 'end', value?: string): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(id === 'start' ? 'Début (vide = maintenant)' : 'Fin')
    .setPlaceholder(
      id === 'start'
        ? 'Ex. : lundi 9h, 12/10 14h30'
        : `Ex. : mercredi 18h (sans heure : ${DEFAULT_END_TIME})`,
    )
    .setStyle(TextInputStyle.Short)
    .setMaxLength(30)
    .setRequired(id === 'end');
  if (value !== undefined) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

/** Un jour et une heure, écrits comme `parseMomentInput` les relit : « Lundi 12/10 09:00 ». */
function momentValue(date: string, time: string | null): string {
  return time ? `${dayLabel(date)} ${time}` : dayLabel(date);
}

/** Une tâche de tous les jours : le texte seulement. */
export function buildPermanentModal(boardId: number, shared = false): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`essort:permmodal:${boardId}:${shared ? 'all' : 'one'}`)
    .setTitle(shared ? 'Tous les jours · toute l’équipe' : 'Tâche de tous les jours')
    .addComponents(labelInput());
}

/** Une tâche sur une période : le texte, le début et la fin (jour et heure). */
export function buildPeriodModal(boardId: number, shared = false): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`essort:periodmodal:${boardId}:${shared ? 'all' : 'one'}`)
    .setTitle(shared ? 'Période · toute l’équipe' : 'Tâche sur une période')
    .addComponents(labelInput(), momentInput('start'), momentInput('end'));
}

/**
 * « Pour qui ? » avant le formulaire d'une tâche permanente ou d'une période :
 * la personne du tableau seule, ou toute l'équipe (sur le tableau de chacun).
 * @param kind 'permanent' ou 'period'
 */
export function buildPlanForButtons(
  board: EssortBoardRow,
  kind: string,
  team: string[],
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`essort:planfor:${board.id}:${kind}.one`)
      .setLabel(`Pour ${board.person}`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`essort:planfor:${board.id}:${kind}.all`)
      .setLabel(`Pour ${team.join(' et ')}`)
      .setStyle(ButtonStyle.Secondary),
  );
}

/** Modifier une tâche permanente (son texte) ou une période (texte, début, fin). */
export function buildSpanEditModal(boardId: number, span: EssortSpanRow): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`essort:spaneditmodal:${boardId}:${span.id}`)
    .setTitle(span.kind === 'permanent' ? 'Modifier la tâche' : 'Modifier la période');
  if (span.kind === 'permanent') return modal.addComponents(labelInput(span.label));
  return modal.addComponents(
    labelInput(span.label),
    momentInput('start', momentValue(span.start_date, span.start_time)),
    momentInput('end', momentValue(span.end_date ?? span.start_date, span.end_time)),
  );
}

/**
 * La période est finie : « Elle a pu être faite ? ». Le message ne dépend
 * d'aucun tableau (`essort:span…:<id de la période>`) : on peut y répondre
 * le lendemain.
 */
export function buildSpanQuestion(
  span: EssortSpanRow,
  mention: string | null,
): { content: string; components: Row[] } {
  return {
    content: `${mention ? `${mention} ` : ''}Fin de la période : **${span.label}** (${periodText(span)}). Elle a pu être faite ?`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`essort:spandone:${span.id}`)
          .setLabel('Faite')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`essort:spanmore:${span.id}`)
          .setLabel('Reporter')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`essort:spandrop:${span.id}`)
          .setLabel('Abandonner')
          .setStyle(ButtonStyle.Secondary),
      ) as Row,
    ],
  };
}

/** « Reporter » : la nouvelle fin, préremplie au lendemain à la même heure. */
export function buildSpanReportModal(span: EssortSpanRow, today: string): ModalBuilder {
  const end = span.end_date && span.end_date > today ? span.end_date : today;
  return new ModalBuilder()
    .setCustomId(`essort:spanmoremodal:${span.id}`)
    .setTitle(truncate(`Reporter · ${span.label}`, 45))
    .addComponents(momentInput('end', momentValue(addDays(end, 1), span.end_time)));
}

/** Rappel de la période dans une réponse : « du lun. 12/10 09:00 au mer. 14/10 18:00 ». */
export function spanWhen(span: EssortSpanRow): string {
  const when =
    span.kind === 'permanent' ? 'tous les jours, jusqu’à ce qu’elle soit faite' : periodText(span);
  return span.shared ? `${when}, pour ${teamText()}` : when;
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
  const open = items.filter((i) => !i.carried).length;
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
            // « Reporter n » et non « n » : les numéros du message du jour
            // cochent une tâche faite, ceux-ci la passent à demain.
            .setLabel(carried ? `${i + j + 1} → demain` : `Reporter ${i + j + 1}`)
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
    content: `${mention ? `${mention} ` : ''}${
      open === 0
        ? 'Tout le reste est fait ou reporté à demain.'
        : `Il reste ${open === 1 ? '1 tâche' : `${open} tâches`} aujourd’hui. Lesquelles reporter à demain ? Le reste sera oublié.`
    }`,
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR_WEEK)
        .setTitle(`🌙 Ce soir · ${dayLabel(board.board_date)}`)
        .setDescription(truncate(lines.join('\n'), LIST_BUDGET))
        .setFooter({
          text: '« Reporter » passe la tâche à demain, un second clic annule. Une tâche faite se coche dans le message du jour.',
        }),
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

// ---------------------------------------------------------------------------
// Modifier une tâche
// ---------------------------------------------------------------------------

/**
 * Une tâche modifiable et son jour. `crmKey` : une action du CRM des jours à
 * venir, pas encore au planning ; elle le devient au moment de la modifier.
 */
export interface EditableTask {
  task: Pick<EssortTaskRow, 'id' | 'label' | 'due_time'>;
  date: string;
  crmKey?: string;
  /** Une tâche permanente ou une période : elle se modifie entière, pas jour par jour. */
  spanId?: number;
}

/**
 * Quelle tâche modifier ? Depuis le jour : celles d'aujourd'hui ; depuis la
 * semaine : celles posées sur les jours à venir (avec leur jour).
 */
export function buildEditPickMenu(
  board: EssortBoardRow,
  items: EditableTask[],
  withDay: boolean,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = items.slice(0, MAX_OPTIONS);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`essort:editpick:${board.id}`)
      .setPlaceholder('Tâche à modifier…')
      .addOptions(
        options.map(({ task, date, crmKey, spanId }, i) => {
          const option = new StringSelectMenuOptionBuilder()
            .setValue(crmKey ? `crm:${crmKey}` : spanId ? `span:${spanId}` : String(task.id))
            .setLabel(
              truncate(
                withDay
                  ? withTime(task.due_time, task.label)
                  : `${i + 1}. ${withTime(task.due_time, task.label)}`,
                100,
              ),
            );
          return withDay ? option.setDescription(dayLabel(date)) : option;
        }),
      ),
  );
}

/** Le formulaire, prérempli : on ne change que ce qu'on veut. */
export function buildEditModal(boardId: number, task: EssortTaskRow, date: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`essort:editmodal:${boardId}:${task.id}`)
    .setTitle('Modifier la tâche')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('label')
          .setLabel('Tâche')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(200)
          .setRequired(true)
          .setValue(truncate(task.label, 200)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('day')
          .setLabel('Jour')
          .setPlaceholder('Ex. : demain, lundi, 12/10')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(true)
          .setValue(dayLabel(date)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('time')
          .setLabel('Heure (vide = sans heure)')
          .setPlaceholder('Ex. : 14h30')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(5)
          .setRequired(false)
          .setValue(task.due_time ?? ''),
      ),
    );
}
