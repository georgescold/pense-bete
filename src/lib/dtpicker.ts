import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import {
  buildDateOptions,
  buildHourOptions,
  buildMinuteOptions,
  type SelectOpt,
} from './datetime';

function buildSelect(
  customId: string,
  placeholder: string,
  options: SelectOpt[],
  selected: string | null,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(
      options.map((o) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(o.label)
          .setValue(o.value)
          .setDefault(selected === o.value),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function buildDateSelect(
  customId: string,
  selected: string | null,
  now: Date = new Date(),
): ActionRowBuilder<StringSelectMenuBuilder> {
  return buildSelect(customId, '📅 Choisis le jour', buildDateOptions(now), selected);
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
