import { createSign } from 'node:crypto';
import { logger } from '../logger';

/**
 * Jeton d'accès Google d'un compte de service (JWT RS256 → access token
 * OAuth2), signé avec `crypto` natif pour éviter d'embarquer tout le SDK
 * `googleapis`. Sert au Google Sheet et à l'agenda.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/**
 * Lit la clé JSON d'un compte de service, brute ou encodée en base64 (plus
 * commode dans Railway). `name` sert au journal si elle est illisible.
 */
export function parseServiceAccount(raw: string | undefined, name: string): ServiceAccount | null {
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(text) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) return null;
    // Railway échappe souvent les retours à la ligne de la clé privée.
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    return parsed;
  } catch (err) {
    logger.error({ err }, `${name} illisible`);
    return null;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Un jeton par compte et par droit demandé, gardé jusqu'à une minute de son expiration. */
const cachedTokens = new Map<string, { value: string; expiresAt: number }>();

export async function accessToken(sa: ServiceAccount, scope: string): Promise<string> {
  const cacheKey = `${sa.client_email} ${scope}`;
  const cached = cachedTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
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
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(`token Google refusé (${res.status}): ${body.error_description ?? 'inconnu'}`);
  }
  cachedTokens.set(cacheKey, {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  });
  return body.access_token;
}
