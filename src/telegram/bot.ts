import { Bot, Context } from 'grammy';
import type { AuthController, AuthEvent } from '../auth/auth-controller';
import type { HealthMonitor } from '../auth/health-monitor';
import {
  CB,
  mainKeyboard,
  loginPrompt,
  renderAuthStatus,
  renderHealthStatus,
  renderRecentErrors,
  renderInfo,
} from './formatters';
import { createAccessControl } from './access-control';
import { extractOauthCallback } from './url-extractor';

export interface TelegramBotDeps {
  token: string;
  userId: number;
  controller: AuthController;
  health: HealthMonitor;
  proxyPort: number;
  callbackPort: number;
  cliVersion?: string;
  logger?: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export interface TelegramBotHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createTelegramBot(deps: TelegramBotDeps): TelegramBotHandle {
  const logger = deps.logger ?? console;
  const bot = new Bot(deps.token);
  bot.use(createAccessControl(deps.userId));

  // ---- state local to the bot -------------------------------------------
  let mutedUntil = 0;
  const recentOutbound = new Map<string, number>(); // body → lastSentAt
  const DEDUP_MS = 60_000;

  async function say(body: string, extra?: Parameters<Context['reply']>[1]) {
    const last = recentOutbound.get(body) ?? 0;
    const nowMs = Date.now();
    if (nowMs - last < DEDUP_MS) return;
    recentOutbound.set(body, nowMs);
    try {
      await bot.api.sendMessage(deps.userId, body, extra);
    } catch (e) {
      logger.error('telegram send failed:', e);
    }
  }

  async function sayKeyboard() {
    await bot.api.sendMessage(deps.userId, 'Choose an action:', {
      reply_markup: mainKeyboard({
        authValid: deps.controller.getState() === 'valid',
        muted: Date.now() < mutedUntil,
      }),
    });
  }

  // ---- event subscriptions -----------------------------------------------
  const unsubscribe = deps.controller.on((e: AuthEvent) => {
    const muted = Date.now() < mutedUntil;
    switch (e.type) {
      case 'stateChange':
        if (e.to === 'broken') {
          void say(`⚠️ Gemini auth broken: ${e.reason}\nPress Login to re-authenticate.`, {
            reply_markup: mainKeyboard({ authValid: false, muted }),
          });
        }
        break;
      case 'loginStarted':
        void say(
          loginPrompt(e.authUrl, {
            callbackServerReady: deps.controller.getSnapshot().callbackServerReady ?? false,
            port: deps.callbackPort,
          }),
          { reply_markup: mainKeyboard({ authValid: false, muted }) },
        );
        break;
      case 'loginCompleted':
        void say('✅ Authenticated.');
        break;
      case 'loginFailed':
        void say(`❌ Login failed: ${e.reason}\nPress Regenerate to try again.`);
        break;
      case 'probeFailed':
        if (!muted) void say(`⚠️ Probe failed: ${e.reason}`);
        break;
    }
  });

  // ---- commands -----------------------------------------------------------
  bot.command('start', async (ctx) => { await ctx.reply('Gemini proxy bot ready.', { reply_markup: mainKeyboard({ authValid: deps.controller.getState() === 'valid', muted: Date.now() < mutedUntil }) }); });
  bot.command('help', async (ctx) => { await ctx.reply([
    'Commands:',
    '/login — start or regenerate OAuth login',
    '/logout — delete cached credentials',
    '/status — auth + health status',
    '/ping — live countTokens call to Gemini',
    '/errors — last 10 errors',
    '/mute — silence probe alerts for 1h',
    '/unmute — re-enable alerts',
  ].join('\n'), { reply_markup: mainKeyboard({ authValid: deps.controller.getState() === 'valid', muted: Date.now() < mutedUntil }) }); });

  const onLogin = async (ctx: Context) => {
    try {
      const { authUrl } = await deps.controller.startLogin('telegram');
      await ctx.reply(loginPrompt(authUrl, {
        callbackServerReady: deps.controller.getSnapshot().callbackServerReady ?? false,
        port: deps.callbackPort,
      }));
    } catch (e: unknown) {
      await ctx.reply(`❌ Cannot start login: ${(e as Error).message}`);
    }
  };
  bot.command('login', onLogin);
  bot.callbackQuery(CB.LOGIN, async (ctx) => { await ctx.answerCallbackQuery(); await onLogin(ctx); });
  bot.callbackQuery(CB.REGENERATE, async (ctx) => { await ctx.answerCallbackQuery(); await onLogin(ctx); });

  const onLogout = async (ctx: Context) => {
    try {
      await deps.controller.logout();
      await ctx.reply('🔓 Logged out. Cached credentials deleted.');
    } catch (e: unknown) {
      await ctx.reply(`Cannot logout: ${(e as Error).message}`);
    }
  };
  bot.command('logout', onLogout);
  bot.callbackQuery(CB.LOGOUT, async (ctx) => { await ctx.answerCallbackQuery(); await onLogout(ctx); });

  const onStatus = async (ctx: Context) => {
    await ctx.reply(renderHealthStatus(deps.controller.getSnapshot(), deps.health.getSnapshot()));
  };
  bot.command('status', onStatus);
  bot.callbackQuery(CB.STATUS, async (ctx) => { await ctx.answerCallbackQuery(); await onStatus(ctx); });

  const onAuthStatus = async (ctx: Context) => {
    await ctx.reply(renderAuthStatus(deps.controller.getSnapshot()));
  };
  bot.callbackQuery(CB.AUTH_STATUS, async (ctx) => { await ctx.answerCallbackQuery(); await onAuthStatus(ctx); });

  const onPing = async (ctx: Context) => {
    const models = deps.controller.getSnapshot().models;
    const pingModel = models && models.length > 0 ? models[0] : undefined;
    if (!pingModel) {
      await ctx.reply('❌ Ping unavailable: no models configured (set MODEL=)');
      return;
    }
    await ctx.reply(`🩺 Pinging Gemini (${pingModel})…`);
    const r = await deps.health.pingGemini(pingModel);
    if (r.ok) await ctx.reply(`✅ Ping ok (${r.latencyMs} ms)`);
    else await ctx.reply(`❌ Ping failed: ${r.error}`);
  };
  bot.command('ping', onPing);
  bot.callbackQuery(CB.PING, async (ctx) => { await ctx.answerCallbackQuery(); await onPing(ctx); });

  const onErrors = async (ctx: Context) => {
    await ctx.reply(renderRecentErrors(deps.health.getSnapshot()));
  };
  bot.command('errors', onErrors);
  bot.callbackQuery(CB.ERRORS, async (ctx) => { await ctx.answerCallbackQuery(); await onErrors(ctx); });

  const onInfo = async (ctx: Context) => {
    await ctx.reply(renderInfo(deps.controller.getSnapshot(), {
      proxyPort: deps.proxyPort,
      callbackPort: deps.callbackPort,
      cliVersion: deps.cliVersion,
    }));
  };
  bot.callbackQuery(CB.INFO, async (ctx) => { await ctx.answerCallbackQuery(); await onInfo(ctx); });

  const onMute = async (ctx: Context) => {
    mutedUntil = Date.now() + 60 * 60 * 1000;
    await ctx.reply('🔇 Probe alerts muted for 1h.');
  };
  bot.command('mute', onMute);
  bot.callbackQuery(CB.MUTE, async (ctx) => { await ctx.answerCallbackQuery(); await onMute(ctx); });

  const onUnmute = async (ctx: Context) => {
    mutedUntil = 0;
    await ctx.reply('🔔 Alerts unmuted.');
  };
  bot.command('unmute', onUnmute);
  bot.callbackQuery(CB.UNMUTE, async (ctx) => { await ctx.answerCallbackQuery(); await onUnmute(ctx); });

  // ---- URL pasting --------------------------------------------------------
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text ?? '';
    if (text.startsWith('/')) return;
    try {
      const parsed = extractOauthCallback(text);
      await deps.controller.completeLoginWithCode(parsed.code, parsed.state);
    } catch (e: unknown) {
      const name = (e as { name?: string }).name;
      if (name === 'InvalidCallbackUrlError') {
        if (/oauth2callback|code=/.test(text)) {
          await ctx.reply(`⚠️ Could not parse callback URL: ${(e as Error).message}`);
        }
        return;
      }
      if (name === 'NoPendingLoginError') {
        await ctx.reply('No pending login. Press Login or /login first.');
        return;
      }
      if (name === 'StateMismatchError') {
        await ctx.reply('State mismatch — this URL is from a previous login attempt. Press Regenerate.');
        return;
      }
      await ctx.reply(`❌ Login failed: ${(e as Error).message}`);
    }
  });

  bot.catch((err) => {
    logger.error('telegram bot error:', err);
  });

  let started = false;
  return {
    async start() {
      if (started) return;
      started = true;
      try {
        await bot.api.getMe();
      } catch (e) {
        logger.error('telegram: getMe failed — disabling bot:', e);
        return;
      }
      void bot.start();
      await sayKeyboard();
    },
    async stop() {
      unsubscribe();
      await bot.stop();
    },
  };
}
