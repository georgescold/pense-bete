import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import {
  buildDayOptions,
  buildHourOptions,
  buildMinuteOptions,
  buildPeriodOptions,
  type SelectOpt,
} from './datetime';

function buildSelect(
  customId: string,
  placeholder: string,
  options: SelectOpt[],
  selected: string | null,
  disabled = false,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const safeOptions = options.length > 0 ? options : [{ value: '__none__', label: '—' }];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setDisabled(disabled || options.length === 0)
    .addOptions(
      safeOptions.map((o) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(o.label)
          .setValue(o.value)
          .setDefault(selected === o.value),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function buildPeriodSelect(
  customId: string,
  selected: string | null,
  now: Date = new Date(),
): ActionRowBuilder<StringSelectMenuBuilder> {
  return buildSelect(customId, '🗓️ Choisis le mois', buildPeriodOptions(now), selected);
}

export function buildDaySelect(
  customId: string,
  periodValue: string | null,
  selected: string | null,
  now: Date = new Date(),
): ActionRowBuilder<StringSelectMenuBuilder> {
  if (!periodValue) {
    return buildSelect(customId, '📅 Choisis d\'abord le mois', [], selected, true);
  }
  return buildSelect(customId, '📅 Choisis le jour', buildDayOptions(periodValue, now), selected);
}

export function buildHourSelect(
  customId: string,
  selected: number | null,
): ActionRowBuilder<StringSelectMenuBuilder> {
  return buildSelect(
    customId,
    "🕐 Choisis l'heure",
    buildHourOptions(),
    selected === null ? null : String(selected),
  );
}

export function buildMinuteSelect(
  customId: string,
  selected: number | null,
): ActionRowBuilder<StringSelectMenuBuilder> {
  return buildSelect(
    customId,
    '⏱️ Choisis les minutes',
    buildMinuteOptions(),
    selected === null ? null : String(selected),
  );
}
