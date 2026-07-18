import { supabase } from './supabase';

export type ScheduleType = 'once' | 'recurring';
export type ReminderStatus = 'scheduled' | 'awaiting_ack' | 'done';

export interface ReminderRow {
  id: number;
  user_id: string;
  channel_id: string;
  guild_id: string | null;
  message: string;
  schedule_type: ScheduleType;
  cron_expression: string | null;
  run_at: string | null;
  next_run_at: string;
  raw_input: string;
  is_paused: boolean;
  is_last_day_of_month: boolean;
  color: number;
  target_user_id: string | null;
  escalation_enabled: boolean;
  escalation_step: number;
  status: ReminderStatus;
  created_at: string;
}

export interface NewReminder {
  user_id: string;
  channel_id: string;
  guild_id: string | null;
  message: string;
  schedule_type: ScheduleType;
  cron_expression: string | null;
  run_at: string | null;
  next_run_at: string;
  raw_input: string;
  is_last_day_of_month: boolean;
  color: number;
  target_user_id: string | null;
  escalation_enabled: boolean;
}

export type ReminderPatch = Partial<{
  next_run_at: string;
  run_at: string | null;
  status: ReminderStatus;
  escalation_step: number;
  escalation_enabled: boolean;
  is_paused: boolean;
  raw_input: string;
}>;

const TABLE = 'reminders';

export async function insertReminder(r: NewReminder): Promise<ReminderRow> {
  const { data, error } = await supabase.from(TABLE).insert(r).select().single();
  if (error) throw new Error(`insertReminder: ${error.message}`);
  return data as ReminderRow;
}

export async function getReminderById(id: number): Promise<ReminderRow | null> {
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`getReminderById: ${error.message}`);
  return (data as ReminderRow | null) ?? null;
}

export async function listRemindersByUser(userId: string): Promise<ReminderRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('next_run_at', { ascending: true });
  if (error) throw new Error(`listRemindersByUser: ${error.message}`);
  return (data as ReminderRow[]) ?? [];
}

export async function listAllActive(): Promise<ReminderRow[]> {
  const { data, error } = await supabase.from(TABLE).select('*').eq('is_paused', false);
  if (error) throw new Error(`listAllActive: ${error.message}`);
  return (data as ReminderRow[]) ?? [];
}

export async function deleteReminder(id: number): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw new Error(`deleteReminder: ${error.message}`);
}

export async function setPaused(id: number, isPaused: boolean): Promise<ReminderRow | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ is_paused: isPaused })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(`setPaused: ${error.message}`);
  return (data as ReminderRow | null) ?? null;
}

export async function updateNextRunAt(id: number, nextRunAt: Date): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ next_run_at: nextRunAt.toISOString() })
    .eq('id', id);
  if (error) throw new Error(`updateNextRunAt: ${error.message}`);
}

export async function updateReminder(
  id: number,
  patch: ReminderPatch,
): Promise<ReminderRow | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(`updateReminder: ${error.message}`);
  return (data as ReminderRow | null) ?? null;
}
