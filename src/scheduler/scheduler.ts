import cron, { ScheduledTask } from 'node-cron';
import parser from 'cron-parser';
import type { Client } from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import type { ReminderRow } from '../db/repository';
import { fireReminder } from './trigger';

interface LongTimeout {
  cancel: () => void;
}

interface ScheduledEntry {
  kind: 'cron' | 'timeout';
  task?: ScheduledTask;
  timeout?: LongTimeout;
}

const MAX_TIMEOUT = 2_000_000_000; // ~23 days, safely under int32 limit

function scheduleLongTimeout(fn: () => void, delayMs: number): LongTimeout {
  let timer: NodeJS.Timeout | null = null;
  let cancelled = false;
  const loop = (remaining: number) => {
    if (cancelled) return;
    if (remaining <= MAX_TIMEOUT) {
      timer = setTimeout(fn, Math.max(0, remaining));
    } else {
      timer = setTimeout(() => loop(remaining - MAX_TIMEOUT), MAX_TIMEOUT);
    }
  };
  loop(delayMs);
  return {
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function computeNextCronRun(cronExpr: string, from: Date = new Date()): Date {
  const interval = parser.parseExpression(cronExpr, {
    currentDate: from,
    tz: config.TIMEZONE,
  });
  return interval.next().toDate();
}

export function isLastDayOfMonthInParis(now: Date = new Date()): boolean {
  // Get today's day-of-month in Paris time
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayParts = fmt.formatToParts(now);
  const todayDay = Number.parseInt(
    todayParts.find((p) => p.type === 'day')!.value,
    10,
  );
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const tomorrowParts = fmt.formatToParts(tomorrow);
  const tomorrowDay = Number.parseInt(
    tomorrowParts.find((p) => p.type === 'day')!.value,
    10,
  );
  // If tomorrow's day < today's day, we wrapped to the next month
  return tomorrowDay < todayDay;
}

export class Scheduler {
  private entries = new Map<number, ScheduledEntry>();

  constructor(private client: Client) {}

  schedule(reminder: ReminderRow): void {
    // Cancel any existing entry
    this.unschedule(reminder.id);

    if (reminder.is_paused) {
      logger.debug({ id: reminder.id }, 'reminder is paused, skipping schedule');
      return;
    }

    if (reminder.schedule_type === 'once') {
      const delay = new Date(reminder.next_run_at).getTime() - Date.now();
      const fire = () => {
        this.entries.delete(reminder.id);
        void fireReminder(this.client, reminder.id, this);
      };
      const timeout = scheduleLongTimeout(fire, delay);
      this.entries.set(reminder.id, { kind: 'timeout', timeout });
      logger.info(
        { id: reminder.id, fireIn: `${Math.round(delay / 1000)}s` },
        'scheduled once reminder',
      );
      return;
    }

    // recurring
    if (!reminder.cron_expression) {
      logger.error({ id: reminder.id }, 'recurring reminder without cron_expression');
      return;
    }
    if (!cron.validate(reminder.cron_expression)) {
      logger.error(
        { id: reminder.id, cron: reminder.cron_expression },
        'invalid cron expression',
      );
      return;
    }
    const task = cron.schedule(
      reminder.cron_expression,
      () => {
        if (reminder.is_last_day_of_month && !isLastDayOfMonthInParis()) {
          logger.debug({ id: reminder.id }, 'skipping non-last-day-of-month tick');
          return;
        }
        void fireReminder(this.client, reminder.id, this);
      },
      { timezone: config.TIMEZONE },
    );
    this.entries.set(reminder.id, { kind: 'cron', task });
    logger.info(
      { id: reminder.id, cron: reminder.cron_expression },
      'scheduled recurring reminder',
    );
  }

  unschedule(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.kind === 'cron' && entry.task) {
      entry.task.stop();
    } else if (entry.kind === 'timeout' && entry.timeout) {
      entry.timeout.cancel();
    }
    this.entries.delete(id);
    logger.debug({ id }, 'unscheduled reminder');
  }

  size(): number {
    return this.entries.size;
  }
}
