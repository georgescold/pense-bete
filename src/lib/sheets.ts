import { config } from '../config';
import { logger } from '../logger';
import { accessToken, parseServiceAccount, type ServiceAccount } from './googleAuth';

/**
 * Client Google Sheets minimal.
 *
 * Une clé API ne permet QUE la lecture de documents publics : l'API Sheets
 * refuse toute écriture avec un 401 CREDENTIALS_MISSING. On passe donc par un
 * compte de service (voir `googleAuth`).
 */

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEET_TAB = 'Journal';

function serviceAccount(): ServiceAccount | null {
  return parseServiceAccount(config.GOOGLE_SERVICE_ACCOUNT_JSON, 'GOOGLE_SERVICE_ACCOUNT_JSON');
}

export function isSheetsConfigured(): boolean {
  return Boolean(serviceAccount() && config.GOOGLE_SHEET_ID);
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const sa = serviceAccount();
  if (!sa) throw new Error('compte de service Google absent');
  const token = await accessToken(sa, SCOPE);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${config.GOOGLE_SHEET_ID}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const JOURNAL_HEADER = ['Date', 'Jour', 'Type', 'Tâche', 'Statut', 'Reportée', 'Faite à', 'Bilan du jour'];

/** Onglets dont on a déjà vérifié l'existence : évite une lecture des métadonnées à chaque ajout. */
const knownTabs = new Set<string>();

/** Crée l'onglet et sa ligne d'en-tête au premier usage. */
async function ensureTab(tab: string, header: string[]): Promise<void> {
  if (knownTabs.has(tab)) return;
  const meta = (await api('')) as { sheets?: { properties?: { title?: string } }[] };
  const exists = (meta.sheets ?? []).some((s) => s.properties?.title === tab);
  if (!exists) {
    await api(':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: tab } } }],
      }),
    });
    await api(`/values/${encodeURIComponent(`${tab}!A1`)}:append?valueInputOption=USER_ENTERED`, {
      method: 'POST',
      body: JSON.stringify({ values: [header] }),
    });
    logger.info({ tab }, 'onglet Google Sheets créé');
  }
  knownTabs.add(tab);
}

/**
 * Ajoute des lignes à la suite d'un onglet et renvoie la plage écrite
 * (ex. « Essort!A12:H12 »), qui permet d'effacer la ligne plus tard.
 */
export async function appendRowsTo(
  tab: string,
  header: string[],
  rows: string[][],
): Promise<string | null> {
  if (rows.length === 0) return null;
  await ensureTab(tab, header);
  try {
    const res = (await api(
      `/values/${encodeURIComponent(`${tab}!A1`)}:append?valueInputOption=USER_ENTERED`,
      { method: 'POST', body: JSON.stringify({ values: rows }) },
    )) as { updates?: { updatedRange?: string } } | null;
    return res?.updates?.updatedRange ?? null;
  } catch (err) {
    // L'onglet a pu être supprimé à la main : on revérifiera au prochain essai.
    knownTabs.delete(tab);
    throw err;
  }
}

/** Vide une plage (la ligne reste, sans contenu). */
export async function clearRange(range: string): Promise<void> {
  await api(`/values/${encodeURIComponent(range)}:clear`, { method: 'POST', body: '{}' });
}

export async function appendRows(rows: string[][]): Promise<void> {
  await appendRowsTo(SHEET_TAB, JOURNAL_HEADER, rows);
}
