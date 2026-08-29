import { createSign } from 'node:crypto';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Client Google Sheets minimal.
 *
 * Une clé API ne permet QUE la lecture de documents publics : l'API Sheets
 * refuse toute écriture avec un 401 CREDENTIALS_MISSING. On passe donc par un
 * compte de service (JWT RS256 → access token OAuth2), signé ici avec `crypto`
 * natif pour éviter d'embarquer tout le SDK `googleapis`.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEET_TAB = 'Journal';

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

function serviceAccount(): ServiceAccount | null {
  const raw = config.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    // Accepte le JSON brut ou encodé en base64 (plus commode dans Railway).
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(text) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) return null;
    // Railway échappe souvent les retours à la ligne de la clé privée.
    parsed.private_key = parsed.private_key.replace(/\n/g, '\n');
    return parsed;
  } catch (err) {
    logger.error({ err }, 'GOOGLE_SERVICE_ACCOUNT_JSON illisible');
    return null;
  }
}

export function isSheetsConfigured(): boolean {
  return Boolean(serviceAccount() && config.GOOGLE_SHEET_ID);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const sa = serviceAccount();
  if (!sa) throw new Error('compte de service Google absent');

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = base64url(signer.sign(sa.private_key));
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`token Google refusé (${res.status}): ${body.error_description ?? 'inconnu'}`);
  }
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await accessToken();
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

/** Crée l'onglet "Journal" et sa ligne d'en-tête au premier usage. */
async function ensureTab(): Promise<void> {
  const meta = (await api('')) as { sheets?: { properties?: { title?: string } }[] };
  const exists = (meta.sheets ?? []).some((s) => s.properties?.title === SHEET_TAB);
  if (exists) return;

  await api(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: SHEET_TAB } } }],
    }),
  });
  await api(`/values/${encodeURIComponent(`${SHEET_TAB}!A1`)}:append?valueInputOption=USER_ENTERED`, {
    method: 'POST',
    body: JSON.stringify({
      values: [
        ['Date', 'Jour', 'Type', 'Tâche', 'Statut', 'Reportée', 'Faite à', 'Bilan du jour'],
      ],
    }),
  });
  logger.info({ tab: SHEET_TAB }, 'onglet Google Sheets créé');
}

export async function appendRows(rows: string[][]): Promise<void> {
  if (rows.length === 0) return;
  await ensureTab();
  await api(`/values/${encodeURIComponent(`${SHEET_TAB}!A1`)}:append?valueInputOption=USER_ENTERED`, {
    method: 'POST',
    body: JSON.stringify({ values: rows }),
  });
}
