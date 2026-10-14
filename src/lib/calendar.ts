import { config } from '../config';
import { accessToken, parseServiceAccount, type ServiceAccount } from './googleAuth';

/**
 * Client Google Agenda minimal (API v3), par un compte de service avec qui
 * l'agenda est partagé en « Apporter des modifications aux événements ».
 */

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export type EventBody = Omit<CalendarEvent, 'id' | 'status'>;

function serviceAccount(): ServiceAccount | null {
  return (
    parseServiceAccount(
      config.GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON,
      'GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON',
    ) ?? parseServiceAccount(config.GOOGLE_SERVICE_ACCOUNT_JSON, 'GOOGLE_SERVICE_ACCOUNT_JSON')
  );
}

export function isCalendarConfigured(): boolean {
  return Boolean(config.GOOGLE_CALENDAR_ID && serviceAccount());
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const sa = serviceAccount();
  if (!sa || !config.GOOGLE_CALENDAR_ID) throw new Error('agenda Google non configuré');
  const token = await accessToken(sa, SCOPE);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.GOOGLE_CALENDAR_ID)}${path}`,
    {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    const error = new Error(`Agenda ${res.status}: ${text.slice(0, 300)}`) as Error & {
      status?: number;
    };
    error.status = res.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

/** Tous les événements (récurrences dépliées) qui touchent [from, to[. */
export async function listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      maxResults: '2500',
      fields: 'nextPageToken,items(id,status,summary,description,start,end,extendedProperties)',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = (await api(`/events?${params}`)) as {
      items?: CalendarEvent[];
      nextPageToken?: string;
    };
    events.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return events;
}

/** Sans invités : Google n'envoie aucun e-mail. */
export async function insertEvent(body: EventBody): Promise<void> {
  await api('/events?sendUpdates=none', { method: 'POST', body: JSON.stringify(body) });
}

/** Remplace l'événement entier : il peut passer de « toute la journée » à un créneau. */
export async function updateEvent(id: string, body: EventBody): Promise<void> {
  await api(`/events/${encodeURIComponent(id)}?sendUpdates=none`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** Un événement déjà supprimé (à la main, entre-temps) n'est pas une erreur. */
export async function deleteEvent(id: string): Promise<void> {
  try {
    await api(`/events/${encodeURIComponent(id)}?sendUpdates=none`, { method: 'DELETE' });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404 && status !== 410) throw err;
  }
}
