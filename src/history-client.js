import * as React from 'react';
import { createHistory } from './history.js';
import { createComposers } from './composer.js';
import { classifyInput, decideAction } from './intent.js';
import { userPromptTextOf } from './prompt.js';

export const historyInject = ['slots', 'conversation', 'shortcuts', 'sessions'];

function createSessionHistoryReader(sessions, isAlive, t) {
  return async (sessionId) => {
    if (!isAlive() || typeof sessions?.binding !== 'function') return [];
    const binding = sessions.binding(sessionId);
    const session = binding?.session;
    if (session === null || session === undefined) throw new Error(t('history.unavailable', { sessionId }));
    if (session.openState !== 'open' && typeof session.open === 'function') await session.open();
    if (!isAlive()) return [];
    let pages = 0;
    if (session.hasMore === true && typeof session.loadOlder === 'function') {
      try {
        await session.loadOlder();
        pages = 1;
      } catch (error) {
        if (isAlive()) console.warn(t('history.pageFailed', { sessionId }), error);
      }
    }
    if (!isAlive()) return [];
    const source = binding.eventSource ?? session.eventSource;
    const snapshot = typeof source?.getSnapshot === 'function' ? source.getSnapshot() : undefined;
    const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
    const texts = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || entry.type === 'transient') continue;
      const text = userPromptTextOf(entry.event);
      if (text.trim() !== '') texts.push(text);
    }
    console.info(t('history.hydrated', { sessionId }), {
      sessionId, bindingKeys: Object.keys(binding), openState: session.openState,
      hasEventSource: source !== undefined && source !== null, pages,
      entryCount: entries.length, textCount: texts.length, hasMore: session.hasMore === true,
    });
    return { texts, hasMore: session.hasMore === true };
  };
}

function normalizeDraftText(value) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
}

/** 每个原生 Entry 的 ctx 独占仓库、订阅和槽注册；关闭不改当前草稿。 */
export function applyInputHistory(ctx, i18n) {
  const t = (key, params) => typeof i18n?.t === 'function' ? i18n.t(key, params) : key;
  return ctx.effect(() => {
    let alive = true;
    let warnedMissingSession = false;
    const history = createHistory({ i18n });
    const composers = createComposers(ctx.conversation, i18n);
    const written = new Map();
    const offs = [];
    const readSessionTexts = createSessionHistoryReader(ctx.sessions, () => alive, t);

    function remember(off) {
      if (typeof off !== 'function') return off;
      let pending = true;
      const once = () => {
        if (!pending) return;
        pending = false;
        off();
      };
      if (alive) offs.push(once);
      else once();
      return once;
    }

    function teardown() {
      if (!alive) return;
      alive = false;
      history.dispose();
      composers.dispose();
      for (const off of offs.splice(0).reverse()) {
        try { off(); } catch (error) { console.error(t('history.unregisterFailed'), error); }
      }
      written.clear();
    }

    function handleInput(input) {
      if (!alive) return;
      const classified = classifyInput(input);
      if (classified.kind === 'skip') return;
      const sessionId = composers.sessionOfTarget(input.context.target);
      if (sessionId === null) return;
      const shell = composers.shellOf(sessionId);
      if (shell === null) return;
      if (classified.kind === 'record') {
        const sent = composers.lastNonEmptyDraftOf(sessionId);
        if (sent !== null && sent.trim() !== '') {
          history.push(sessionId, sent);
          written.delete(sessionId);
        }
        return;
      }
      const draft = composers.readDraft(shell);
      if (draft === null) return;
      if (history.isBrowsing(sessionId)) {
        const mine = written.get(sessionId);
        if (mine !== undefined && normalizeDraftText(mine) !== normalizeDraftText(draft.text)) {
          console.info(t('history.draftChanged', { sessionId }), { expected: mine, actual: draft.text });
          history.reset(sessionId);
        }
      }
      const decision = decideAction(classified.kind, {
        text: draft.detectText, caret: draft.caret, browsing: history.isBrowsing(sessionId),
      });
      if (!decision.act) return;
      const next = classified.kind === 'prev' ? history.up(sessionId, draft.snapshot) : history.down(sessionId);
      if (next === null || next === undefined) return;
      if (classified.kind === 'prev' && history.atOldest(sessionId) && history.canLoadMore(sessionId)) {
        void history.loadMore(sessionId, readSessionTexts);
      }
      if (alive && composers.writeDraft(shell, next)) {
        if (typeof input.consume === 'function') input.consume();
        written.set(sessionId, typeof next === 'string' ? next : String(next.text ?? ''));
      }
    }

    function ComposerAnchor(props) {
      const sessionId = props?.sessionId;
      React.useEffect(() => {
        if (!alive) return undefined;
        if (typeof sessionId !== 'string') {
          if (!warnedMissingSession) {
            warnedMissingSession = true;
            console.warn(t('history.missingSession'));
          }
          return undefined;
        }
        props.mount(sessionId);
        return () => props.unmount(sessionId);
      }, [sessionId]);
      return null;
    }

    try {
      remember(ctx.shortcuts.observeFixedInput(handleInput));
      for (const [direction, code, arrow] of [['prev', 'ArrowUp', '↑'], ['next', 'ArrowDown', '↓']]) {
        try {
          remember(ctx.shortcuts.registerFixed({
            id: 'dsh-replay.history.' + direction, keys: [arrow], group: 'application',
            label: () => t('history.' + direction), bindings: [{ code, modifiers: [] }],
          }));
        } catch (error) {
          console.error(t('history.fixedFailed'), 'dsh-replay.history.' + direction, error);
        }
      }
      remember(ctx.slots.inject('conversation.composer.dock', () => {
        if (!alive) return undefined;
        return ctx.slots.register({
          name: 'conversation.composer.dock', id: 'dsh-replay.history', order: 90,
          inject: (sessionId) => ({
            sessionId,
            mount: (id) => {
              if (!alive) return;
              composers.mount(id);
              // 每次回填最多翻一页；路由重挂载仍由仓库 hydrated 锁去重。
              void history.hydrate(id, readSessionTexts);
            },
            unmount: (id) => composers.unmount(id),
          }),
        }, ComposerAnchor);
      }));
    } catch (error) {
      teardown();
      throw error;
    }
    return teardown;
  }, 'dsh-replay.history');
}
