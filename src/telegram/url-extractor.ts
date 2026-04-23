import { InvalidCallbackUrlError } from '../auth/errors';

export interface OauthCallback {
  code: string;
  state: string;
}

// Accept three shapes:
//   1) a full http(s) URL with /oauth2callback and ?code=&state=
//   2) a bare query string "code=...&state=..."
//   3) either of the above embedded in arbitrary text
//
// Strategy: scan for the first occurrence of code=... and state=... in the
// input, build a URLSearchParams from that span, then read both values.
export function extractOauthCallback(text: string): OauthCallback {
  if (!text || typeof text !== 'string') {
    throw new InvalidCallbackUrlError('empty or non-string input');
  }

  // Try: full URL with a query string.
  const urlMatch = text.match(/https?:\/\/\S+/i);
  const queryTail = urlMatch ? urlMatch[0].split('?')[1] : undefined;

  // Fallback: any substring that looks like key=value&... containing code and state.
  const fallback = text.match(/[?&]?(?:code|state)=[^\s&]+(?:&[^\s&]+=[^\s&]+)*/i)?.[0]
    ?.replace(/^[?&]/, '');

  const candidate = queryTail ?? fallback ?? text;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(candidate);
  } catch {
    throw new InvalidCallbackUrlError('could not parse URL params');
  }

  const code = params.get('code');
  const state = params.get('state');

  if (!code) throw new InvalidCallbackUrlError('missing `code` param');
  if (!state) throw new InvalidCallbackUrlError('missing `state` param');

  return { code, state };
}
