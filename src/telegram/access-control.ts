import type { MiddlewareFn, Context } from 'grammy';

export function createAccessControl(allowedUserId: number): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;
    if (chatType !== 'private') return; // silently ignore
    if (fromId !== allowedUserId || chatId !== allowedUserId) return;
    await next();
  };
}
