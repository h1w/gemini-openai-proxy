import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import {
  getCachedCredentialPath,
  getGoogleAccountIdCachePath,
  writeCredentials,
  writeGoogleAccountId,
  buildAuthUrl,
  OAUTH_SCOPE,
  SIGN_IN_SUCCESS_URL,
  SIGN_IN_FAILURE_URL,
} from '../../src/auth/oauth-flow';

test('getCachedCredentialPath returns ~/.gemini/oauth_creds.json', () => {
  assert.equal(
    getCachedCredentialPath(),
    path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
  );
});

test('getGoogleAccountIdCachePath returns ~/.gemini/google_account_id', () => {
  assert.equal(
    getGoogleAccountIdCachePath(),
    path.join(os.homedir(), '.gemini', 'google_account_id'),
  );
});

test('OAUTH_SCOPE has the three required scopes', () => {
  assert.deepEqual(OAUTH_SCOPE, [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ]);
});

test('sign-in URLs are the Google developer doc URLs', () => {
  assert.ok(SIGN_IN_SUCCESS_URL.includes('auth_success_gemini'));
  assert.ok(SIGN_IN_FAILURE_URL.includes('auth_failure_gemini'));
});

test('writeCredentials creates parent dir and writes JSON', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'oauthflow-'));
  const target = path.join(tmp, 'sub', 'creds.json');
  await writeCredentials(target, { access_token: 'a', refresh_token: 'b' });
  const on_disk = JSON.parse(await fs.readFile(target, 'utf-8'));
  assert.equal(on_disk.access_token, 'a');
  assert.equal(on_disk.refresh_token, 'b');
  await fs.rm(tmp, { recursive: true });
});

test('writeGoogleAccountId creates parent dir and writes plain text', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'oauthflow-'));
  const target = path.join(tmp, 'sub', 'id');
  await writeGoogleAccountId(target, '1234567890');
  const on_disk = await fs.readFile(target, 'utf-8');
  assert.equal(on_disk, '1234567890');
  await fs.rm(tmp, { recursive: true });
});

test('buildAuthUrl produces a URL with expected params', () => {
  const url = buildAuthUrl({
    clientId: 'CID.apps.googleusercontent.com',
    clientSecret: 'SECRET',
    redirectUri: 'http://localhost:8085/oauth2callback',
    state: 'deadbeef',
  });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'accounts.google.com');
  assert.equal(parsed.searchParams.get('state'), 'deadbeef');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://localhost:8085/oauth2callback');
  assert.equal(parsed.searchParams.get('client_id'), 'CID.apps.googleusercontent.com');
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
  const scope = parsed.searchParams.get('scope') ?? '';
  for (const s of OAUTH_SCOPE) assert.ok(scope.includes(s));
});
