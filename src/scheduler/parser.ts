import * as chrono from 'chrono-node';

export type ParsedSchedule =
  | { type: 'once'; runAt: Date; humanReadable: string }
  | {
      type: 'recurring';
      cron: string;
      humanReadable: string;
      isLastDayOfMonth?: boolean;
    };

const JOURS: Record<string, number> = {
  dimanche: 0,
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
};

const JOURS_LABELS: Record<number, string> = {
  0: 'dimanche',
  1: 'lundi',
  2: 'mardi',
  3: 'mercredi',
  4: 'jeudi',
  5: 'vendredi',
  6: 'samedi',
};

function parseHourMinute(h: string, m?: string): { hours: number; minutes: number } {
  const hours = Number.parseInt(h, 10);
  const minutes = m ? Number.parseInt(m, 10) : 0;
  if (!Number.isFinite(hours) || hours < 0 || hours > 23) {
    throw new Error(`Heure invalide : ${h}h`);
  }
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 59) {
    throw new Error(`Minutes invalides : ${m}`);
  }
  return { hours, minutes };
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatTime(hours: number, minutes: number): string {
  return `${pad2(hours)}:${pad2(minutes)}`;
}

function pluralLabel(n: number, dayLabel: string): string {
  return n > 1 ? `${dayLabel}s` : dayLabel;
}

export function formatHumanDate(date: Date): string {
  return date.toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  });
}

export function parseFrenchSchedule(input: string, now: Date = new Date()): ParsedSchedule {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('Expression vide');
  }
  const normalized = trimmed.toLowerCase();

  // 1. tous les jours à 7h(30)
  {
    const m = /^tous les jours à (\d{1,2})h(?:(\d{2}))?$/.exec(normalized);
    if (m) {
      const { hours, minutes } = parseHourMinute(m[1]!, m[2]);
      return {
        type: 'recurring',
        cron: `${minutes} ${hours} * * *`,
        humanReadable: `tous les jours à ${formatTime(hours, minutes)} (heure de Paris)`,
      };
    }
  }

  // 2. tous les <jours> (et <jour>...) à 9h(30)
  {
    const dayPattern = '(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)s?';
    const re = new RegExp(
      `^tous les (${dayPattern}(?:\\s+et\\s+${dayPattern})*) à (\\d{1,2})h(?:(\\d{2}))?$`,
    );
    const m = re.exec(normalized);
    if (m) {
      const daysStr = m[1]!;
      const dayMatches = [
        ...daysStr.matchAll(/(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)/g),
      ];
      const dayNums = Array.from(new Set(dayMatches.map((d) => JOURS[d[1]!]!))).sort(
        (a, b) => a - b,
      );
      const { hours, minutes } = parseHourMinute(m[2]!, m[3]);
      const cron = `${minutes} ${hours} * * ${dayNums.join(',')}`;
      const labels = dayNums.map((n) => pluralLabel(2, JOURS_LABELS[n]!)).join(' et ');
      return {
        type: 'recurring',
        cron,
        humanReadable: `tous les ${labels} à ${formatTime(hours, minutes)} (heure de Paris)`,
      };
    }
  }

  // 3. tous les 15 du mois à 9h
  {
    const m = /^tous les (\d{1,2}) du mois à (\d{1,2})h(?:(\d{2}))?$/.exec(normalized);
    if (m) {
      const day = Number.parseInt(m[1]!, 10);
      if (day < 1 || day > 31) throw new Error(`Jour du mois invalide : ${day}`);
      const { hours, minutes } = parseHourMinute(m[2]!, m[3]);
      return {
        type: 'recurring',
        cron: `${minutes} ${hours} ${day} * *`,
        humanReadable: `le ${day} de chaque mois à ${formatTime(hours, minutes)} (heure de Paris)`,
      };
    }
  }

  // 4. le dernier jour du mois à 18h
  {
    const m = /^le dernier jour du mois à (\d{1,2})h(?:(\d{2}))?$/.exec(normalized);
    if (m) {
      const { hours, minutes } = parseHourMinute(m[1]!, m[2]);
      return {
        type: 'recurring',
        cron: `${minutes} ${hours} 28-31 * *`,
        humanReadable: `le dernier jour du mois à ${formatTime(hours, minutes)} (heure de Paris)`,
        isLastDayOfMonth: true,
      };
    }
  }

  // 5. toutes les N minutes/heures
  {
    const m = /^toutes les (\d+) (minutes?|heures?)$/.exec(normalized);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      const unit = m[2]!;
      if (n < 1) throw new Error('Intervalle invalide');
      if (unit.startsWith('minute')) {
        if (n > 59) throw new Error('Intervalle en minutes trop grand (max 59)');
        return {
          type: 'recurring',
          cron: `*/${n} * * * *`,
          humanReadable: `toutes les ${n} minutes (heure de Paris)`,
        };
      }
      if (n > 23) throw new Error('Intervalle en heures trop grand (max 23)');
      return {
        type: 'recurring',
        cron: `0 */${n} * * *`,
        humanReadable: `toutes les ${n} heures (heure de Paris)`,
      };
    }
  }

  // 6. "dans N (minutes|heures|jours)" — fast-path ponctuel
  {
    const m = /^dans (\d+)\s*(min|minutes?|h|heures?|j|jours?)$/.exec(normalized);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      const unit = m[2]!;
      let ms = 0;
      if (unit.startsWith('min')) ms = n * 60_000;
      else if (unit === 'h' || unit.startsWith('heure')) ms = n * 3_600_000;
      else ms = n * 86_400_000;
      const runAt = new Date(now.getTime() + ms);
      return {
        type: 'once',
        runAt,
        humanReadable: formatHumanDate(runAt),
      };
    }
  }

  // 7. Fallback chrono-node FR pour expressions ponctuelles libres
  const chronoInput = trimmed
    // chrono préfère "9h00" ou "9:00"; insère un séparateur si l'utilisateur tape "9h" seul
    .replace(/(\d{1,2})h(?!\d)/gi, '$1h00');

  const results = chrono.fr.parse(chronoInput, now, { forwardDate: true });
  if (results.length === 0) {
    throw new Error(
      `Expression non comprise : "${input}". Exemples : "dans 2h", "demain 9h", "tous les jours à 7h", "tous les lundis à 8h".`,
    );
  }
  const runAt = results[0]!.start.date();
  if (runAt.getTime() <= now.getTime()) {
    throw new Error(`La date interprétée est dans le passé : ${formatHumanDate(runAt)}`);
  }
  return {
    type: 'once',
    runAt,
    humanReadable: formatHumanDate(runAt),
  };
}
