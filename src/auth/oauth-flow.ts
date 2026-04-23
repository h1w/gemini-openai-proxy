// Pure-ish helpers for the OAuth dance. No HTTP server here — that lives in
// callback-server.ts. No state — AuthController owns state.

import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { OAuth2Client, Credentials } from 'google-auth-library';

export const OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export const SIGN_IN_SUCCESS_URL =
  'https://developers.google.com/gemini-code-assist/auth_success_gemini';
export const SIGN_IN_FAILURE_URL =
  'https://developers.google.com/gemini-code-assist/auth_failure_gemini';

const GEMINI_DIR = '.gemini';
const CREDENTIAL_FILENAME = 'oauth_creds.json';
const GOOGLE_ACCOUNT_ID_FILENAME = 'google_account_id';

export function getCachedCredentialPath(): string {
  return path.join(os.homedir(), GEMINI_DIR, CREDENTIAL_FILENAME);
}

export function getGoogleAccountIdCachePath(): string {
  return path.join(os.homedir(), GEMINI_DIR, GOOGLE_ACCOUNT_ID_FILENAME);
}

export async function loadUpstreamOauthClientCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  const envId = process.env.GEMINI_OAUTH_CLIENT_ID;
  const envSecret = process.env.GEMINI_OAUTH_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }

  const upstreamPath = require.resolve(
    '@google/gemini-cli-core/dist/src/code_assist/oauth2.js',
  );
  const source = await fs.readFile(upstreamPath, 'utf-8');
  const idMatch = source.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/);
  const secretMatch = source.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/);
  if (!idMatch || !secretMatch) {
    throw new Error(
      'OAuth: could not extract installed-app credentials from ' +
        '@google/gemini-cli-core. Set GEMINI_OAUTH_CLIENT_ID and ' +
        'GEMINI_OAUTH_CLIENT_SECRET explicitly.',
    );
  }
  return { clientId: idMatch[1], clientSecret: secretMatch[1] };
}

export async function writeCredentials(
  filePath: string,
  credentials: Credentials | unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(credentials, null, 2));
}

export async function writeGoogleAccountId(filePath: string, id: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, id, 'utf-8');
}

export async function readCachedCredentials(filePath: string): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

export async function deleteCachedCredentials(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code !== 'ENOENT') throw e;
  }
}

export function buildAuthUrl(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  state: string;
}): string {
  const client = new OAuth2Client({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
  });
  return client.generateAuthUrl({
    redirect_uri: args.redirectUri,
    access_type: 'offline',
    scope: OAUTH_SCOPE,
    state: args.state,
  });
}

export async function exchangeCode(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ credentials: Credentials; client: OAuth2Client }> {
  const client = new OAuth2Client({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
  });
  const { tokens } = await client.getToken({
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  client.setCredentials(tokens);
  return { credentials: tokens, client };
}

export async function fetchGoogleAccountId(client: OAuth2Client): Promise<string | null> {
  try {
    const { token } = await client.getAccessToken();
    if (!token) return null;
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const userInfo = (await response.json()) as { id?: string };
    return userInfo.id || null;
  } catch {
    return null;
  }
}

// Probe — no Gemini quota cost. Returns { ok, reason? }.
export async function probeCachedCredentials(
  credsFilePath: string,
  clientId: string,
  clientSecret: string,
): Promise<{ ok: boolean; reason?: string; expiresAt?: number; hasRefreshToken?: boolean }> {
  const creds = await readCachedCredentials(credsFilePath);
  if (!creds) return { ok: false, reason: 'no cached credentials' };

  try {
    const client = new OAuth2Client({ clientId, clientSecret });
    client.setCredentials(creds);
    const { token } = await client.getAccessToken();
    if (!token) return { ok: false, reason: 'no access token returned' };
    await client.getTokenInfo(token);
    return {
      ok: true,
      expiresAt: (creds as Credentials).expiry_date ?? undefined,
      hasRefreshToken: !!(creds as Credentials).refresh_token,
    };
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message ?? String(e);
    return { ok: false, reason: msg };
  }
}
