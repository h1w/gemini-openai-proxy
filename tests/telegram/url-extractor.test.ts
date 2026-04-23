import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOauthCallback } from '../../src/telegram/url-extractor';
import { InvalidCallbackUrlError } from '../../src/auth/errors';

test('extracts code and state from a full callback URL', () => {
  const url = 'http://localhost:8085/oauth2callback?code=abc123&state=xyz789';
  assert.deepEqual(extractOauthCallback(url), { code: 'abc123', state: 'xyz789' });
});

test('extracts from https host', () => {
  const url = 'https://example.com/oauth2callback?code=c&state=s';
  assert.deepEqual(extractOauthCallback(url), { code: 'c', state: 's' });
});

test('extracts when URL is surrounded by other text', () => {
  const text = 'here is the url: http://localhost:8085/oauth2callback?code=abc&state=xyz trailing';
  assert.deepEqual(extractOauthCallback(text), { code: 'abc', state: 'xyz' });
});

test('extracts from a bare query string (no host)', () => {
  assert.deepEqual(
    extractOauthCallback('code=abc&state=xyz'),
    { code: 'abc', state: 'xyz' },
  );
});

test('extracts even when params are url-encoded', () => {
  const url = 'http://localhost:8085/oauth2callback?code=a%2Fb%3Dc&state=d%26e';
  assert.deepEqual(extractOauthCallback(url), { code: 'a/b=c', state: 'd&e' });
});

test('accepts params in any order', () => {
  assert.deepEqual(
    extractOauthCallback('http://x/oauth2callback?state=xyz&code=abc'),
    { code: 'abc', state: 'xyz' },
  );
});

test('throws when code is missing', () => {
  assert.throws(
    () => extractOauthCallback('http://x/oauth2callback?state=xyz'),
    (err: Error) => err.name === 'InvalidCallbackUrlError',
  );
});

test('throws when state is missing', () => {
  assert.throws(
    () => extractOauthCallback('http://x/oauth2callback?code=abc'),
    InvalidCallbackUrlError,
  );
});

test('throws on completely unrelated text', () => {
  assert.throws(
    () => extractOauthCallback('hello world'),
    InvalidCallbackUrlError,
  );
});

test('throws on empty string', () => {
  assert.throws(() => extractOauthCallback(''), InvalidCallbackUrlError);
});

test('ignores duplicate code params by taking the first', () => {
  assert.deepEqual(
    extractOauthCallback('code=first&code=second&state=s'),
    { code: 'first', state: 's' },
  );
});
