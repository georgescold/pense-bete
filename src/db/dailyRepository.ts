import { supabase } from './supabase';

export type PlanStatus = 'draft' | 'active' | 'closed';
export type DayType = 'work' | 'rest';

export interface DayPlanRow {
  id: number;
  user_id: string;
  channel_id: string;
  guild_id: string | null;
  plan_date: string; // 'YYYY-MM-DD' en heure murale Europe/Paris
  status: PlanStatus;
  day_type: DayType;
  prep_message_id: string | null;
  board_message_id: string | null;
  closed_at: string | null;
  sheet_synced_at: string | null;
  created_at: string;
}

export interface DailyTaskRow {
  id: number;
  plan_id: number;
  label: string;
  position: number;
  is_done: boolean;
  done_at: string | null;
  carried_over: boolean;
  created_at: string;
}

export type DayPlanPatch = Partial<{
  status: PlanStatus;
  day_type: DayType;
  prep_message_id: string | null;
  board_message_id: string | null;
  closed_at: string | null;
  sheet_synced_at: string | null;
}>;

const PLANS = 'day_plans';
const TASKS = 'daily_tasks';

export async function getPlan(userId: string, planDate: string): Promise<DayPlanRow | null> {
  const { data, error } = await supabase
    .from(PLANS)
    .select()
    .eq('user_id', userId)
    .eq('plan_date', planDate)
    .maybeSingle();
  if (error) throw new Error(`getPlan: ${error.message}`);
  return (data as DayPlanRow) ?? null;
}

export async function getPlanById(id: number): Promise<DayPlanRow | null> {
  const { data, error } = await supabase.from(PLANS).select().eq('id', id).maybeSingle();
  if (error) throw new Error(`getPlanById: ${error.message}`);
  return (data as DayPlanRow) ?? null;
}

/**
 * Récupère le plan du jour demandé, ou le crée s'il n'existe pas.
 * L'unicité (user_id, plan_date) garantit qu'un double appel ne duplique rien.
 */
export async function ensurePlan(
  userId: string,
  channelId: string,
  guildId: string | null,
  planDate: string,
): Promise<DayPlanRow> {
  const existing = await getPlan(userId, planDate);
  if (existing) return existing;
  const { data, error } = await supabase
    .from(PLANS)
    .insert({ user_id: userId, channel_id: channelId, guild_id: guildId, plan_date: planDate })
    .select()
    .single();
  if (error) {
    // Course possible entre le job de 18h et un clic manuel : on relit.
    const retry = await getPlan(userId, planDate);
    if (retry) return retry;
    throw new Error(`ensurePlan: ${error.message}`);
  }
  return data as DayPlanRow;
}

export async function updatePlan(id: number, patch: DayPlanPatch): Promise<DayPlanRow | null> {
  const { data, error } = await supabase
    .from(PLANS)
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(`updatePlan: ${error.message}`);
  return (data as DayPlanRow) ?? null;
}

export async function listTasks(planId: number): Promise<DailyTaskRow[]> {
  const { data, error } = await supabase
    .from(TASKS)
    .select()
    .eq('plan_id', planId)
    .order('position', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`listTasks: ${error.message}`);
  return (data ?? []) as DailyTaskRow[];
}

export async function addTask(
  planId: number,
  label: string,
  carriedOver = false,
): Promise<DailyTaskRow> {
  const existing = await listTasks(planId);
  const position = existing.length > 0 ? Math.max(...existing.map((t) => t.position)) + 1 : 0;
  const { data, error } = await supabase
    .from(TASKS)
    .insert({ plan_id: planId, label, position, carried_over: carriedOver })
    .select()
    .single();
  if (error) throw new Error(`addTask: ${error.message}`);
  return data as DailyTaskRow;
}

/** Relit un lot de tâches par identifiant (source d'un report d'une journée à l'autre). */
export async function listTasksByIds(ids: number[]): Promise<DailyTaskRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from(TASKS).select().in('id', ids);
  if (error) throw new Error(`listTasksByIds: ${error.message}`);
  return (data ?? []) as DailyTaskRow[];
}

export async function setTaskDone(id: number, done: boolean): Promise<DailyTaskRow | null> {
  const { data, error } = await supabase
    .from(TASKS)
    .update({ is_done: done, done_at: done ? new Date().toISOString() : null })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(`setTaskDone: ${error.message}`);
  return (data as DailyTaskRow) ?? null;
}

export async function deleteTask(id: number): Promise<void> {
  const { error } = await supabase.from(TASKS).delete().eq('id', id);
  if (error) throw new Error(`deleteTask: ${error.message}`);
}

/** Journées terminées mais pas encore poussées dans Google Sheets. */
export async function listPlansToSync(): Promise<DayPlanRow[]> {
  const { data, error } = await supabase
    .from(PLANS)
    .select()
    .eq('status', 'closed')
    .is('sheet_synced_at', null)
    .order('plan_date', { ascending: true });
  if (error) throw new Error(`listPlansToSync: ${error.message}`);
  return (data ?? []) as DayPlanRow[];
}

/** Plans encore ouverts (préparation ou journée en cours), pour rechargement au boot. */
export async function listOpenPlans(): Promise<DayPlanRow[]> {
  const { data, error } = await supabase
    .from(PLANS)
    .select()
    .in('status', ['draft', 'active'])
    .order('plan_date', { ascending: true });
  if (error) throw new Error(`listOpenPlans: ${error.message}`);
  return (data ?? []) as DayPlanRow[];
}
