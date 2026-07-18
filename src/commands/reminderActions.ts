import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  Interaction,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { logger } from '../logger';
import {
  deleteReminder,
  getReminderById,
  updateNextRunAt,
  updateReminder,
  type ReminderRow,
} from '../db/repository';
import { computeNextCronRun, type Scheduler } from '../scheduler/scheduler';
import {
  buildDaySelect,
  buildHourSelect,
  buildMinuteSelect,
  buildPeriodSelect,
} from '../lib/dtpicker';
import { currentPeriodValue, parisDateValue, selectionToDate } from '../lib/datetime';
import { buildErrorEmbed } from '../lib/embeds';
import { formatFrenchDate } from '../lib/format';

export function isReminderComponent(customId: string): boolean {
  return customId.startsWith('rappel:') || customId.startsWith('redef:');
}

function canManage(r: ReminderRow, userId: string): boolean {
  return r.user_id === userId || r.target_user_id === userId;
}

// ---------------------------------------------------------------------------
// Boutons du message de rappel : Fait / Skip / Reporter / Redéfinir
// ---------------------------------------------------------------------------

async function handleDone(
  interaction: ButtonInteraction,
  id: number,
  scheduler: Scheduler,
): Promise<void> {
  const r = await getReminderById(id);
  // Un rappel ponctuel sans relance est supprimé dès l'envoi → r peut être null.
  if (r) {
    if (!canManage(r, interaction.user.id)) {
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
}

async function handleSkip(
  interaction: ButtonInteraction,
  id: number,
): Promise<void> {
  const r = await getReminderById(id);
  if (!r || !canManage(r, interaction.user.id)) {
    await interaction.reply({
      content: 'Ce rappel ne vous appartient pas.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (r.schedule_type !== 'recurring' || !r.cron_expression) return;
  const next = computeNextCronRun(r.cron_expression, new Date(Date.now() + 60_000));
  await updateNextRunAt(id, next);
  await interaction.update({
    content: `⏭️ Prochaine occurrence prévue : ${formatFrenchDate(next)}`,
    embeds: [],
    components: [],
  });
}

// --- Reporter (snooze) ------------------------------------------------------

interface SnoozeOpt {
  value: string;
  label: string;
  resolve: (now: Date) => Date;
}

const SNOOZE_OPTS: SnoozeOpt[] = [
  { value: '30m', label: 'Dans 30 minutes', resolve: (n) => new Date(n.getTime() + 30 * 60_000) },
  { value: '1h', label: 'Dans 1 heure', resolve: (n) => new Date(n.getTime() + 3_600_000) },
  { value: '3h', label: 'Dans 3 heures', resolve: (n) => new Date(n.getTime() + 3 * 3_600_000) },
  {
    value: 'tonight',
    label: 'Ce soir à 18 h',
    resolve: (n) => {
      const t = selectionToDate(parisDateValue(0, n), 18, 0);
      return t.getTime() > n.getTime() ? t : selectionToDate(parisDateValue(1, n), 18, 0);
    },
  },
  { value: 'tomorrow', label: 'Demain à 9 h', resolve: (n) => selectionToDate(parisDateValue(1, n), 9, 0) },
  { value: '1w', label: 'Dans 1 semaine', resolve: (n) => new Date(n.getTime() + 7 * 86_400_000) },
];
const SNOOZE_BY_VALUE = new Map(SNOOZE_OPTS.map((o) => [o.value, o]));

async function handleSnoozeButton(interaction: ButtonInteraction, id: number): Promise<void> {
  const r = await getReminderById(id);
  if (!r || !canManage(r, interaction.user.id)) {
    await interaction.reply({
      content: 'Ce rappel ne vous appartient pas.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`rappel:snoozepick:${id}`)
    .setPlaceholder('😴 Me le rappeler…')
    .addOptions(
      SNOOZE_OPTS.map((o) =>
        new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value),
      ),
    );
  await interaction.reply({
    content: `Reporter le rappel #${id} :`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSnoozePick(
  interaction: StringSelectMenuInteraction,
  id: number,
  scheduler: Scheduler,
): Promise<void> {
  const r = await getReminderById(id);
  if (!r || !canManage(r, interaction.user.id)) {
    await interaction.update({ content: 'Ce rappel ne vous appartient pas.', components: [] });
    return;
  }
  const opt = SNOOZE_BY_VALUE.get(interaction.values[0]!);
  if (!opt) return;
  const next = opt.resolve(new Date());
  // On repart de zéro dans l'échelle de relance depuis le nouveau moment.
  const updated = await updateReminder(id, {
    status: 'scheduled',
    escalation_step: 0,
    is_paused: false,
    next_run_at: next.toISOString(),
  });
  if (updated) scheduler.schedule(updated);
  await interaction.update({
    content: `😴 Reporté — je te relancerai le **${formatFrenchDate(next)}**.`,
    components: [],
  });
}

// --- Redéfinir (nouveau jour + heure via cascade) ---------------------------

interface RedefState {
  reminderId: number;
  userId: string;
  period: string | null;
  date: string | null;
  hour: number | null;
  min: number | null;
  createdAt: number;
}

const REDEF_STATES = new Map<number, RedefState>();
const REDEF_TTL = 15 * 60_000;

function redefGc(): void {
  const now = Date.now();
  for (const [key, s] of REDEF_STATES) {
    if (now - s.createdAt > REDEF_TTL) REDEF_STATES.delete(key);
  }
}

function redefPreview(s: RedefState): string {
  if (!s.date || s.hour === null || s.min === null) return '*Sélection incomplète…*';
  return `**→ ${formatFrenchDate(selectionToDate(s.date, s.hour, s.min))}**`;
}

function buildRedefPayload(s: RedefState) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`✏️ Redéfinir le rappel #${s.reminderId}`)
    .setDescription(
      'Choisis le nouveau **jour**, l\'**heure**, les **minutes**, puis **Valider**.\n\n' +
        redefPreview(s),
    );
  const ready = !!s.date && s.hour !== null && s.min !== null;
  return {
    embeds: [embed],
    components: [
      buildPeriodSelect(`redef:period:${s.reminderId}`, s.period),
      buildDaySelect(`redef:day:${s.reminderId}`, s.period, s.date),
      buildHourSelect(`redef:hour:${s.reminderId}`, s.hour),
      buildMinuteSelect(`redef:min:${s.reminderId}`, s.min),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`redef:valider:${s.reminderId}`)
          .setLabel('Valider')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!ready),
        new ButtonBuilder()
          .setCustomId(`redef:annuler:${s.reminderId}`)
          .setLabel('Annuler')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

async function handleRedefButton(interaction: ButtonInteraction, id: number): Promise<void> {
  redefGc();
  const r = await getReminderById(id);
  if (!r || !canManage(r, interaction.user.id)) {
    await interaction.reply({
      content: 'Ce rappel ne vous appartient pas.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const s: RedefState = {
    reminderId: id,
    userId: interaction.user.id,
    period: currentPeriodValue(),
    date: null,
    hour: null,
    min: null,
    createdAt: Date.now(),
  };
  REDEF_STATES.set(id, s);
  await interaction.reply({ ...buildRedefPayload(s), flags: MessageFlags.Ephemeral });
}

function getRedef(id: number, userId: string): RedefState | null {
  const s = REDEF_STATES.get(id);
  if (!s || s.userId !== userId) return null;
  return s;
}

async function handleRedefSelect(
  interaction: StringSelectMenuInteraction,
  id: number,
  field: 'period' | 'day' | 'hour' | 'min',
): Promise<void> {
  const s = getRedef(id, interaction.user.id);
  if (!s) {
    await interaction.update({ content: 'Formulaire expiré. Reclique « Redéfinir ».', embeds: [], components: [] });
    return;
  }
  const value = interaction.values[0]!;
  if (field === 'period') {
    s.period = value;
    s.date = null;
  } else if (field === 'day') {
    s.date = value;
  } else if (field === 'hour') {
    s.hour = Number(value);
  } else {
    s.min = Number(value);
  }
  await interaction.update(buildRedefPayload(s));
}

async function handleRedefValider(
  interaction: ButtonInteraction,
  id: number,
  scheduler: Scheduler,
): Promise<void> {
  const s = getRedef(id, interaction.user.id);
  if (!s || !s.date || s.hour === null || s.min === null) {
    await interaction.update({ content: 'Sélection incomplète.', embeds: [], components: [] });
    return;
  }
  const runAt = selectionToDate(s.date, s.hour, s.min);
  if (runAt.getTime() <= Date.now()) {
    await interaction.reply({
      embeds: [buildErrorEmbed(`Cette date est déjà passée : ${formatFrenchDate(runAt)}.`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const updated = await updateReminder(id, {
    status: 'scheduled',
    escalation_step: 0,
    is_paused: false,
    run_at: runAt.toISOString(),
    next_run_at: runAt.toISOString(),
    raw_input: formatFrenchDate(runAt),
  });
  REDEF_STATES.delete(id);
  if (updated) scheduler.schedule(updated);
  await interaction.update({
    content: `✏️ Rappel #${id} redéfini — prochain déclenchement le **${formatFrenchDate(runAt)}**.`,
    embeds: [],
    components: [],
  });
}

async function handleRedefAnnuler(interaction: ButtonInteraction, id: number): Promise<void> {
  REDEF_STATES.delete(id);
  await interaction.update({ content: 'Redéfinition annulée.', embeds: [], components: [] });
}

// ---------------------------------------------------------------------------
// Routeur
// ---------------------------------------------------------------------------

export async function handleReminderComponent(
  interaction: Interaction,
  scheduler: Scheduler,
): Promise<void> {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
  const [namespace, action, idStr] = interaction.customId.split(':');
  const id = Number.parseInt(idStr ?? '', 10);
  if (!Number.isFinite(id)) return;

  if (namespace === 'rappel') {
    if (interaction.isButton()) {
      if (action === 'done') return handleDone(interaction, id, scheduler);
      if (action === 'skip') return handleSkip(interaction, id);
      if (action === 'snooze') return handleSnoozeButton(interaction, id);
      if (action === 'redef') return handleRedefButton(interaction, id);
    }
    if (interaction.isStringSelectMenu() && action === 'snoozepick') {
      return handleSnoozePick(interaction, id, scheduler);
    }
    return;
  }

  if (namespace === 'redef') {
    if (
      interaction.isStringSelectMenu() &&
      (action === 'period' || action === 'day' || action === 'hour' || action === 'min')
    ) {
      return handleRedefSelect(interaction, id, action);
    }
    if (interaction.isButton()) {
      if (action === 'valider') return handleRedefValider(interaction, id, scheduler);
      if (action === 'annuler') return handleRedefAnnuler(interaction, id);
    }
  }
}
