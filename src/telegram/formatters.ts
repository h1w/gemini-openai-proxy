import { InlineKeyboard } from 'grammy';
import type { AuthSnapshot } from '../auth/auth-controller';
import type { HealthSnapshot } from '../auth/health-monitor';

export const CB = {
  LOGIN: 'auth:login',
  REGENERATE: 'auth:regen',
  LOGOUT: 'auth:logout',
  AUTH_STATUS: 'auth:status',
  PING: 'health:ping',
  STATUS: 'health:status',
  ERRORS: 'health:errors',
  INFO: 'meta:info',
  MUTE: 'meta:mute',
  UNMUTE: 'meta:unmute',
  CANCEL: 'auth:cancel',
} as const;

export function mainKeyboard(opts: { authValid: boolean; muted: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (opts.authValid) {
    kb.text('🔄 Regenerate login', CB.REGENERATE).text('❌ Logout', CB.LOGOUT).row();
  } else {
    kb.text('🔐 Login', CB.LOGIN).text('🔄 Regenerate', CB.REGENERATE).row();
  }
  kb.text('📋 Auth status', CB.AUTH_STATUS).text('🩺 Ping Gemini', CB.PING).row();
  kb.text('📊 Status', CB.STATUS).text('📜 Recent errors', CB.ERRORS).row();
  kb.text('ℹ️ Info', CB.INFO);
  if (opts.muted) kb.text('🔔 Unmute', CB.UNMUTE);
  else kb.text('🔇 Mute 1h', CB.MUTE);
  kb.row();
  return kb;
}

export function loginPrompt(
  authUrl: string,
  opts: { callbackServerReady: boolean; port: number },
): string {
  if (opts.callbackServerReady) {
    return (
      '🔐 Open this URL in your browser and sign in:\n\n' +
      `${authUrl}\n\n` +
      `Google will redirect to http://localhost:${opts.port}/oauth2callback. ` +
      'If you cannot reach that port, paste the resulting URL here in chat — I will finish login automatically.'
    );
  }
  return (
    '🔐 Open this URL in your browser and sign in:\n\n' +
    `${authUrl}\n\n` +
    'After sign-in Google will redirect to a localhost URL. ' +
    'Copy that URL from the address bar and paste it here — I will finish login from it.'
  );
}

export function renderAuthStatus(snap: AuthSnapshot): string {
  const parts: string[] = [];
  parts.push(`State: ${snap.state}`);
  parts.push(`Auth type: ${snap.authType}`);
  if (snap.model) parts.push(`Model: ${snap.model}`);
  if (snap.tokenExpiresAt) {
    const delta = Math.round((snap.tokenExpiresAt - Date.now()) / 60000);
    parts.push(`Token expires in: ${delta} min`);
  }
  if (snap.hasRefreshToken !== undefined) parts.push(`Refresh token: ${snap.hasRefreshToken ? 'yes' : 'no'}`);
  if (snap.callbackServerReady !== undefined) {
    parts.push(`Callback server (port): ${snap.callbackServerReady ? 'ready' : 'not bound'}`);
  }
  if (snap.lastSuccessAt) parts.push(`Last success: ${new Date(snap.lastSuccessAt).toISOString()}`);
  if (snap.lastFailureAt) parts.push(`Last failure: ${new Date(snap.lastFailureAt).toISOString()}`);
  if (snap.lastFailureReason) parts.push(`Reason: ${snap.lastFailureReason}`);
  return parts.join('\n');
}

export function renderHealthStatus(auth: AuthSnapshot, health: HealthSnapshot): string {
  const winMin = Math.round(health.window.windowMs / 60000);
  const parts = [
    `Auth state: ${auth.state}`,
    `Window (${winMin}m): ok=${health.window.ok}, fail=${health.window.fail}`,
    health.lastSuccessAt ? `Last success: ${new Date(health.lastSuccessAt).toISOString()}` : 'Last success: —',
    health.lastFailureAt ? `Last failure: ${new Date(health.lastFailureAt).toISOString()} (${health.lastFailureReason ?? ''})` : 'Last failure: —',
    health.probeLastOkAt ? `Probe last ok: ${new Date(health.probeLastOkAt).toISOString()}` : 'Probe: —',
    health.probeLastFailAt ? `Probe last fail: ${new Date(health.probeLastFailAt).toISOString()} (${health.probeLastFailReason ?? ''})` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

export function renderRecentErrors(h: HealthSnapshot): string {
  if (h.recentErrors.length === 0) return 'No errors in the buffer.';
  return h.recentErrors
    .map((e, i) => `${i + 1}. [${new Date(e.at).toISOString()}] ${e.label} ${e.status ?? ''} — ${e.message}`)
    .join('\n');
}

export function renderInfo(auth: AuthSnapshot, extras: { proxyPort: number; callbackPort: number; cliVersion?: string }): string {
  return [
    `CLI impersonation: ${extras.cliVersion ?? 'unknown'}`,
    `AUTH_TYPE: ${auth.authType}`,
    `Model: ${auth.model ?? '(not initialised)'}`,
    `Proxy port: ${extras.proxyPort}`,
    `Callback port: ${extras.callbackPort}`,
    `Callback server: ${auth.callbackServerReady === undefined ? 'n/a' : auth.callbackServerReady ? 'ready' : 'not bound'}`,
  ].join('\n');
}
