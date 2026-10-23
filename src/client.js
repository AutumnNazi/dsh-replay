import { historyInject, applyInputHistory } from './history-client.js';
import { injectMessageRetry, applyMessageRetry } from './retry-client.js';
import { createReplayI18n } from './locale.js';
import { createComponentController, COMPONENT_POLL_MS } from './component-controller.js';

export const inject = ['slots', 'conversation', 'shortcuts', 'sessions', 'locale', 'remote', 'remote.pluginInventory'];

export function apply(ctx) {
  ctx.effect(() => {
    const i18n = createReplayI18n(ctx.locale);
    const controller = createComponentController(ctx, {
      history: { name: 'dsh-replay.history', inject: historyInject, apply(childCtx) { return applyInputHistory(childCtx, i18n); } },
      retry: { name: 'dsh-replay.retry', inject: injectMessageRetry, apply(childCtx) { return applyMessageRetry(childCtx, i18n); } },
    });
    const interval = setInterval(() => { void controller.refresh(); }, COMPONENT_POLL_MS);
    void controller.refresh();
    return async () => {
      clearInterval(interval);
      try { await controller.dispose(); } finally { i18n.dispose(); }
    };
  });
}
