// src/oauth-preflight.ts
//
// Docker-friendly OAuth pre-flight for AUTH_TYPE='oauth-personal'.
//
// gemini-cli-core picks a RANDOM local port for the OAuth callback server,
// which makes it impossible to map that port out of a Docker container.
// This module performs the OAuth dance ourselves on a FIXED port
// (OAUTH_CALLBACK_PORT, default 8085) and writes the resulting tokens to
// ~/.gemini/oauth_creds.json in the exact same format gemini-cli-core expects.
// On the next call, gemini-cli-core finds the cached credentials and never
// starts its own random-port server.

import * as http from 'http';
import * as url from 'url';
import * as crypto from 'crypto';
import * as path from 'node:path';
import * as os from 'os';
import { promises as fs } from 'node:fs';
import { OAuth2Client } from 'google-auth-library';

// Same scopes gemini-cli-core requests. The client id / secret are the
// public "installed application" credentials shipped with gemini-cli-core
// itself; we read them out of the upstream module at runtime so we don't
// duplicate them in this repo (GitHub's secret scanning would block the
// push, and keeping a single source of truth means we pick up any future
// upstream rotation automatically).
const OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

async function loadUpstreamOauthClientCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  // Allow override via env if ever needed, but the default path is to
  // extract the constants baked into the gemini-cli-core bundle.
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
      'OAuth preflight: could not extract installed-app credentials from ' +
        '@google/gemini-cli-core. The upstream module layout may have changed; ' +
        'set GEMINI_OAUTH_CLIENT_ID and GEMINI_OAUTH_CLIENT_SECRET explicitly.',
    );
  }
  return { clientId: idMatch[1], clientSecret: secretMatch[1] };
}

const HTTP_REDIRECT = 301;
const SIGN_IN_SUCCESS_URL =
  'https://developers.google.com/gemini-code-assist/auth_success_gemini';
const SIGN_IN_FAILURE_URL =
  'https://developers.google.com/gemini-code-assist/auth_failure_gemini';

const GEMINI_DIR = '.gemini';
const CREDENTIAL_FILENAME = 'oauth_creds.json';
const GOOGLE_ACCOUNT_ID_FILENAME = 'google_account_id';

const DEFAULT_CALLBACK_PORT = 8085;

function getCachedCredentialPath(): string {
  return path.join(os.homedir(), GEMINI_DIR, CREDENTIAL_FILENAME);
}

function getGoogleAccountIdCachePath(): string {
  return path.join(os.homedir(), GEMINI_DIR, GOOGLE_ACCOUNT_ID_FILENAME);
}

async function hasValidCachedCredentials(
  clientId: string,
  clientSecret: string,
): Promise<boolean> {
  try {
    const keyFile =
      process.env.GOOGLE_APPLICATION_CREDENTIALS || getCachedCredentialPath();
    const creds = await fs.readFile(keyFile, 'utf-8');
    const client = new OAuth2Client({ clientId, clientSecret });
    client.setCredentials(JSON.parse(creds));
    const { token } = await client.getAccessToken();
    if (!token) return false;
    await client.getTokenInfo(token);
    return true;
  } catch {
    return false;
  }
}

async function writeCredentials(credentials: unknown): Promise<void> {
  const filePath = getCachedCredentialPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(credentials, null, 2));
}

async function writeGoogleAccountId(id: string): Promise<void> {
  const filePath = getGoogleAccountIdCachePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, id, 'utf-8');
}

async function fetchGoogleAccountId(
  client: OAuth2Client,
): Promise<string | null> {
  try {
    const { token } = await client.getAccessToken();
    if (!token) return null;
    const response = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) return null;
    const userInfo = (await response.json()) as { id?: string };
    return userInfo.id || null;
  } catch {
    return null;
  }
}

/**
 * Run the OAuth flow on a fixed, user-controlled port. Safe to await from
 * the entrypoint — if credentials are already cached this returns immediately
 * without binding any port.
 */
export async function ensureOauthCredentials(): Promise<void> {
  if ((process.env.AUTH_TYPE ?? 'gemini-api-key') !== 'oauth-personal') {
    return;
  }

  const { clientId, clientSecret } = await loadUpstreamOauthClientCredentials();

  if (await hasValidCachedCredentials(clientId, clientSecret)) {
    console.log('OAuth: cached credentials are valid, skipping login flow.');
    return;
  }

  const port = Number(process.env.OAUTH_CALLBACK_PORT ?? DEFAULT_CALLBACK_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid OAUTH_CALLBACK_PORT: ${process.env.OAUTH_CALLBACK_PORT}`,
    );
  }

  const redirectUri = `http://localhost:${port}/oauth2callback`;
  const state = crypto.randomBytes(32).toString('hex');

  const client = new OAuth2Client({ clientId, clientSecret });

  const authUrl = client.generateAuthUrl({
    redirect_uri: redirectUri,
    access_type: 'offline',
    scope: OAUTH_SCOPE,
    state,
  });

  console.log(
    '\n================ OAuth login required ================\n' +
      `Open this URL in a browser on your host machine:\n\n${authUrl}\n\n` +
      `Google will redirect back to ${redirectUri}.\n` +
      `Make sure port ${port} is reachable (in Docker: add "-p ${port}:${port}").\n` +
      '======================================================\n',
  );

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url || req.url.indexOf('/oauth2callback') === -1) {
          res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL });
          res.end();
          reject(new Error('Unexpected request: ' + req.url));
          return;
        }

        const qs = new url.URL(req.url, `http://localhost:${port}`).searchParams;

        if (qs.get('error')) {
          res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL });
          res.end();
          reject(new Error(`Error during authentication: ${qs.get('error')}`));
          return;
        }

        if (qs.get('state') !== state) {
          res.end('State mismatch. Possible CSRF attack');
          reject(new Error('State mismatch. Possible CSRF attack'));
          return;
        }

        const code = qs.get('code');
        if (!code) {
          reject(new Error('No code found in request'));
          return;
        }

        const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
        client.setCredentials(tokens);

        await writeCredentials(tokens);

        try {
          const accountId = await fetchGoogleAccountId(client);
          if (accountId) await writeGoogleAccountId(accountId);
        } catch (e) {
          console.error('OAuth: failed to cache Google Account ID:', e);
        }

        res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_SUCCESS_URL });
        res.end();
        console.log('OAuth: credentials cached to', getCachedCredentialPath());
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });

    server.on('error', reject);
    server.listen(port, () => {
      console.log(`OAuth: callback server listening on port ${port}`);
    });
  });
}
