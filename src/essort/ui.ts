import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { config } from '../config';
import type { EssortBoardRow, EssortTaskRow } from '../db/essortRepository';
import { formatPlanDate } from '../daily/ui';
import { truncate } from '../lib/format';
import { recordUrl } from './airtable';
import { shortDate } from './planner';

const COLOR_OPEN = 0x5865f2; // bleu : journée en cours
const COLOR_DONE = 0x57f287; // vert : tout est fait
const COLOR_ARCHIVED = 0x4f545c; // gris : jour passé

const BUTTONS_PER_ROW = 5;
/** 4 lignes de boutons + 1 ligne d'actions = les 5 lignes autorisées par Discord. */
const MAX_TASK_BUTTONS = 20;
/** Au-delà, 3 lignes de boutons et le reste dans un menu (25 options max). */
const BUTTONS_BEFORE_SELECT = 15;
const MAX_OPTIONS = 25;

type Row = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** 'YYYY-MM-DD' → 'ven. 09/10'. */
function weekdayDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12)).toLocaleDateString(
    'fr-FR',
    { weekday: 'short', timeZone: 'UTC' },
  );
  return `${weekday} ${shortDate(date)}`;
}

function parisTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: config.TIMEZONE,
  });
}

function progressBar(done: number, total: number): string {
  const slots = 10;
  const filled = total === 0 ? 0 : Math.round((done / total) * slots);
  return `${'▰'.repeat(filled)}${'▱'.repeat(slots - filled)}  **${done}/${total}**`;
}

/** Place réservée à la liste : un embed entier ne peut dépasser 6 000 caractères. */
const LIST_BUDGET = 2800;
const FIELD_BUDGET = 600;

function taskLine(t: EssortTaskRow, position: number, withDetails: boolean): string {
  const num = `\`${String(position).padStart(2, ' ')}\``;
  if (t.is_done) return `${num}  ~~${t.label}~~`;
  const extra = withDetails
    ? [t.details, t.record_id ? `[fiche Airtable](${recordUrl(t.record_id)})` : null].filter(
        Boolean,
      )
    : [];
  const sub = extra.length > 0 ? `\n      ↳ ${extra.join(' · ')}` : '';
  return `${num}  **${t.label}**${sub}`;
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

function bullets(lines: string[], max = FIELD_BUDGET): string {
  return truncate(lines.map((l) => `• ${l}`).join('\n'), max);
}

export function buildBoardEmbed(board: EssortBoardRow, tasks: EssortTaskRow[]): EmbedBuilder {
  const done = tasks.filter((t) => t.is_done).length;
  const archived = Boolean(board.archived_at);
  const allDone = tasks.length > 0 && done === tasks.length;
  const extras = board.extras ?? {};

  const embed = new EmbedBuilder()
    .setColor(archived ? COLOR_ARCHIVED : allDone ? COLOR_DONE : COLOR_OPEN)
    .setAuthor({ name: `Essort · ${board.person}` })
    .setTitle(`${archived ? '🏁' : '☀️'} ${capitalize(formatPlanDate(board.board_date))}`)
    .setDescription(
      tasks.length === 0
        ? 'Aucune tâche aujourd’hui.\n**➕** pour en ajouter une.'
        : `${progressBar(done, tasks.length)}\n​\n${taskLines(tasks)}`,
    );

  if (extras.airtableError) {
    embed.addFields({
      name: '⚠️ Airtable injoignable',
      value: 'La lecture a échoué : la liste peut être incomplète. **🔄** pour réessayer.',
    });
  }
  if (extras.stale?.length) {
    embed.addFields({
      name: '📝 Fait, date à changer dans Airtable',
      value: bullets(extras.stale.map((s) => `${s.label} (validé le ${shortDate(s.doneOn)})`)),
    });
  }
  if (extras.upcoming?.length) {
    embed.addFields({
      name: '📅 À venir',
      value: bullets(extras.upcoming.map((u) => `${weekdayDate(u.date)} · ${u.label}`)),
    });
  }
  if (extras.undated?.length) {
    embed.addFields({
      name: '🗓️ Sans date de prochaine action',
      value: bullets(extras.undated),
    });
  }
  if (extras.unassigned?.length) {
    embed.addFields({
      name: '🆕 Sans responsable dans Airtable',
      value: bullets(extras.unassigned),
    });
  }

  embed.setFooter({
    text: archived
      ? 'Journée passée'
      : `${board.read_at ? `Airtable lu à ${parisTime(board.read_at)}` : 'Airtable non lu'} · une tâche validée part dans le Google Sheet`,
  });
  return embed;
}

/** Intro au-dessus de l'embed : la mention ne sert que s'il y a quelque chose à faire. */
export function boardIntro(mention: string | null, remaining: number, total: number): string {
  if (total === 0) return 'Rien à faire aujourd’hui côté Essort.';
  if (remaining === 0) return 'Tout est fait pour aujourd’hui. ✅';
  const count = remaining === 1 ? '1 tâche' : `${remaining} tâches`;
  return `${mention ? `${mention} ` : ''}${count} aujourd’hui.`;
}

export function buildBoardComponents(board: EssortBoardRow, tasks: EssortTaskRow[]): Row[] {
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
      new ButtonBuilder()
        .setCustomId(`essort:refresh:${board.id}`)
        .setLabel('Relire Airtable')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary),
    ) as Row,
  );
  return rows;
}

/**
 * Menu « que retirer ? », affiché à la seule personne qui a cliqué : il ne
 * prend aucune des 5 lignes du tableau. Numéros identiques à ceux de la liste.
 */
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
            .setLabel(truncate(`${i + 1}. ${t.label}`, 100))
            .setDescription(
              t.is_done
                ? 'Faite (sa ligne sera effacée du Sheet)'
                : t.source === 'airtable'
                  ? 'Airtable : ne reviendra pas tant que le lead ne change pas'
                  : 'Ajoutée à la main',
            ),
        ),
      ),
  );
}
