import { config } from '../config';

/**
 * Lecture du CRM Airtable d'Essort (table « Leads »).
 *
 * ⚠️ LECTURE SEULE. Ce module n'émet que des GET, et le token attendu n'a que
 * le scope `data.records:read` : même par erreur, le bot ne peut rien écrire.
 * Le suivi des tâches faites vit dans Supabase et le Google Sheet, jamais
 * dans Airtable.
 *
 * Les champs sont lus par identifiant (`fld…`) : renommer une colonne dans
 * Airtable ne casse rien.
 */
export const LEAD_FIELDS = {
  email: 'fld3fu8u4cVF5HOhP',
  nom: 'fldCt0UyrAhSOfmn3',
  type: 'fldopdIB84JS8gLjG',
  telephone: 'fldJ0eDa4F2xXtWMh',
  cabinet: 'fld8U8sYcUF79xbtW',
  qualite: 'fldW7zntEV7VeG3Yz',
  verdict: 'fldzZEEIH2pifrddi',
  action: 'fldoKWTeurNLE6UB0',
  gestion: 'fldjzU1y98xIrXgdV',
  prochainEvenement: 'fldc256zxsQtZD0Ra',
  dateAction: 'fldvfwyPMMCpsXQmE',
} as const;

type LeadField = keyof typeof LEAD_FIELDS;

export type Lead = { id: string } & Record<LeadField, string | null>;

interface AirtablePage {
  records?: { id: string; fields: Record<string, unknown> }[];
  offset?: string;
}

/** Texte nettoyé, ou null si vide (Airtable laisse traîner espaces et retours). */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function toLead(record: { id: string; fields: Record<string, unknown> }): Lead {
  const lead = { id: record.id } as Lead;
  for (const [key, fieldId] of Object.entries(LEAD_FIELDS) as [LeadField, string][]) {
    lead[key] = text(record.fields[fieldId]);
  }
  return lead;
}

export function recordUrl(recordId: string): string {
  return `https://airtable.com/${config.AIRTABLE_BASE_ID}/${config.AIRTABLE_LEADS_TABLE}/${recordId}`;
}

/** Tous les leads, page par page (100 par page, limite d'Airtable). */
export async function fetchLeads(): Promise<Lead[]> {
  const token = config.AIRTABLE_TOKEN;
  if (!token) throw new Error('AIRTABLE_TOKEN absent');

  const leads: Lead[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' });
    for (const fieldId of Object.values(LEAD_FIELDS)) params.append('fields[]', fieldId);
    if (offset) params.set('offset', offset);

    const res = await fetch(
      `https://api.airtable.com/v0/${config.AIRTABLE_BASE_ID}/${config.AIRTABLE_LEADS_TABLE}?${params}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable ${res.status}: ${body.slice(0, 200)}`);
    }
    const page = (await res.json()) as AirtablePage;
    for (const record of page.records ?? []) leads.push(toLead(record));
    offset = page.offset;
  } while (offset);

  return leads;
}
