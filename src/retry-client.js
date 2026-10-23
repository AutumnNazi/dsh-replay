import { createRetryAction, UserMessageView } from './retry.js';

export const injectMessageRetry = ['slots', 'sessions'];

export function applyMessageRetry(ctx, i18n) {
  ctx.effect(() => {
    if (!ctx.sessions || typeof ctx.sessions.binding !== 'function') {
      console.warn('[dsh-replay] ' + i18n.t('retry.unavailable'));
      return () => {};
    }
    let alive = true;
    const retry = createRetryAction(ctx.sessions, i18n, () => alive);
    const stop = ctx.slots.inject('conversation.chat.node', () => {
      if (!alive) return () => {};
      try {
        return ctx.slots.register({
          name: 'conversation.chat.node',
          key: 'user',
          priority: -1,
          inject: sessionId => ({ sessionId, i18n, retry: (id, text) => retry.send(id, text) }),
        }, UserMessageView);
      } catch (error) {
        console.error('[dsh-replay] ' + i18n.t('retry.unavailable'), error);
        return () => {};
      }
    });
    return () => {
      alive = false;
      if (typeof stop === 'function') stop();
    };
  });
}
