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

const COLOR_PREP = 0xfaa61a; // ambre : on prépare
const COLOR_BOARD = 0x5865f2; // bleu : journée en cours
const COLOR_DONE = 0x57f287; // vert : tout est fait
const COLOR_CLOSED = 0x4f545c; // gris : journée close

/** Un menu déroulant Discord accepte 25 options ; une ligne accueille 5 boutons. */
const MAX_OPTIONS = 25;
const BUTTONS_PER_ROW = 5;
/** 4 lignes de boutons + 1 ligne d'actions = les 5 lignes autorisées. */
const MAX_TASK_BUTTONS = 20;
/** Au-delà, on garde 3 lignes de boutons et on bascule le reste dans un menu. */
const BUTTONS_BEFORE_SELECT = 15;

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

/** Première lettre en majuscule : 'samedi 30 août' → 'Samedi 30 août'. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Barre pleine (█) sur fond tramé (░), dans un bloc `code` pour rester en
 * chasse fixe. Les cases creuses type ▱ donnaient un rendu vide et transparent.
 */
function progressBar(done: number, total: number): string {
  const slots = 12;
  const filled = total === 0 ? 0 : Math.round((done / total) * slots);
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return `\`${'█'.repeat(filled)}${'░'.repeat(slots - filled)}\`  **${done}/${total}** · ${pct} %`;
}

/**
 * Pas d'emoji de case : ⬜ et ✅ sont rendus en pleine chasse par Discord et
 * forment un pavé de couleur disgracieux. Le numéro en `code` sert de repère
 * vers le bouton correspondant, le barré suffit à marquer ce qui est fait.
 */
function taskLines(tasks: DailyTaskRow[]): string {
  return tasks
    .map((t, i) => {
      const num = `\`${String(i + 1).padStart(2, ' ')}\``;
      const carried = t.carried_over ? '  ↩︎' : '';
      return t.is_done
        ? `${num}  ~~${t.label}~~${carried}`
        : `${num}  **${t.label}**${carried}`;
    })
    .join('\n');
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
    .setAuthor({ name: 'Préparation de demain' })
    .setTitle(`📝 ${capitalize(formatPlanDate(plan.plan_date))}`)
    .setDescription(
      tasks.length > 0
        ? truncate(taskLines(tasks), 3800)
        : '*Ta liste est vide.*\nAjoute tes tâches une par une avec **➕ Ajouter une tâche**.',
    );

  if (pending.length > 0) {
    embed.addFields({
      name: `↩︎ Pas terminé aujourd’hui — ${pending.length} tâche(s)`,
      value: truncate(pending.map((t) => `• ${t.label}`).join('\n'), 1000),
    });
  }

  embed.setFooter({ text: 'Présentée demain à 7h, prête à cocher' });
  return embed;
}

export function buildPrepComponents(
  plan: DayPlanRow,
  tasks: DailyTaskRow[],
  pending: DailyTaskRow[],
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (pending.length > 0) {
    const options = pending.slice(0, MAX_OPTIONS);
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`daily:carry:${plan.id}`)
          .setPlaceholder('↩︎ Reporter à demain…')
          .setMinValues(1)
          .setMaxValues(options.length)
          .addOptions(
            options.map((t) =>
              new StringSelectMenuOptionBuilder()
                .setValue(String(t.id))
                .setLabel(truncate(t.label, 100)),
            ),
          ),
      ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
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
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(tasks.length === 0),
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
  const allDone = tasks.length > 0 && done === tasks.length;

  const embed = new EmbedBuilder()
    .setColor(closed ? COLOR_CLOSED : allDone ? COLOR_DONE : COLOR_BOARD)
    .setAuthor({ name: closed ? 'Journée archivée' : 'Ta journée' })
    .setTitle(`${closed ? '🏁' : allDone ? '🎉' : '☀️'} ${capitalize(formatPlanDate(plan.plan_date))}`);

  if (tasks.length === 0) {
    embed.setDescription(
      '*Aucune tâche pour aujourd’hui.*\nAjoute-en avec **➕ Ajouter une tâche**.',
    );
  } else {
    embed.setDescription(
      `${progressBar(done, tasks.length)}\n​\n${truncate(taskLines(tasks), 3700)}`,
    );
  }

  embed.setFooter({
    text: closed
      ? 'Journée close et archivée dans le Sheet'
      : allDone
        ? 'Tout est fait, bravo'
        : 'Clique sur un numéro pour cocher',
  });
  return embed;
}

export function buildBoardComponents(
  plan: DayPlanRow,
  tasks: DailyTaskRow[],
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  if (plan.status === 'closed') return [];
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  // Un bouton par tâche : cocher se fait en un seul clic.
  const overflow = tasks.length > MAX_TASK_BUTTONS;
  const withButtons = tasks.slice(0, overflow ? BUTTONS_BEFORE_SELECT : MAX_TASK_BUTTONS);

  for (let i = 0; i < withButtons.length; i += BUTTONS_PER_ROW) {
    const slice = withButtons.slice(i, i + BUTTONS_PER_ROW);
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        slice.map((t, j) =>
          new ButtonBuilder()
            .setCustomId(`daily:toggle:${plan.id}:${t.id}`)
            // La couleur porte l'état : vert = fait, gris = à faire. Un emoji
            // de case ajouterait un bloc blanc sans rien apprendre de plus.
            .setLabel(t.is_done ? `✓ ${i + j + 1}` : String(i + j + 1))
            .setStyle(t.is_done ? ButtonStyle.Success : ButtonStyle.Secondary),
        ),
      ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
    );
  }

  // Au-delà de 20 tâches les boutons ne tiennent plus : le reste passe en menu.
  if (overflow) {
    const rest = tasks.slice(BUTTONS_BEFORE_SELECT, BUTTONS_BEFORE_SELECT + MAX_OPTIONS);
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`daily:pick:${plan.id}`)
          .setPlaceholder(`Cocher une tâche ${BUTTONS_BEFORE_SELECT + 1}+…`)
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
      ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`daily:add:${plan.id}`)
        .setLabel('Ajouter')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`daily:undo:${plan.id}`)
        .setLabel('Retirer la dernière')
        .setEmoji('↩️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(tasks.length === 0),
      new ButtonBuilder()
        .setCustomId(`daily:close:${plan.id}`)
        .setLabel('Clôturer')
        .setEmoji('🏁')
        .setStyle(ButtonStyle.Danger),
    ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
  );
  return rows;
}
