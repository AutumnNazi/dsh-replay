/**
 * composer 适配层：把「按键落点」翻译成「哪个会话的输入框」，并把草稿读写全部收敛到宿主公开的服务面上。
 *
 * 读：conversation.input.shell(sessionId).projection
 * 写：shell.actions.setDraft(...)
 * 这里不写任何 DOM——不碰 value、不碰 textContent、不碰选区对象。
 * 所有宿主调用都吞掉异常：本层会在 React 的提交阶段被调用，抛出去会炸掉整个输入框。
 */

/**
 * 建一个 composer 登记簿。
 * @param {unknown} conversation - 宿主 conversation 服务
 * @returns 登记簿
 */
export function createComposers(conversation, i18n) {
  const t = (key, params) => typeof i18n?.t === 'function' ? i18n.t(key, params) : key;
  let closed = false;
  /** 已经挂载输入框的会话（由 composer.dock 槽位组件在 commit 阶段报告，不靠「全局当前会话」猜）。 */
  const mounted = new Set();
  /** 每个会话「最近一次非空草稿」，用来在回车那一刻取到真正会被发出去的文本。 */
  const lastNonEmpty = new Map();
  /** 每个会话的 store 订阅解注册函数。 */
  const sessionStops = new Map();
  /** 宿主异常只吵一次：反复刷屏会把真正的错误淹掉。 */
  let warnedHostError = false;

  function warnOnce(message, error) {
    if (warnedHostError) return;
    warnedHostError = true;
    console.warn(message, error);
  }

  /**
   * 取某个会话的输入外壳；服务不可用或会话已释放时返回 null，绝不抛到调用方。
   * @param {string} sessionId - 会话标识
   * @returns {object|null}
   */
  function shellOf(sessionId) {
    if (closed) return null;
    try {
      const input = conversation === null || conversation === undefined ? undefined : conversation.input;
      if (input === null || input === undefined || typeof input.shell !== 'function') return null;
      return input.shell(sessionId) ?? null;
    } catch (error) {
      warnOnce(t('composer.shellFailed', { sessionId }), error);
      return null;
    }
  }

  /**
   * 取输入框的 contenteditable 根元素，用来把按键落点归属到会话。
   * @param {object} shell - 输入外壳
   * @returns {Element|null}
   */
  function rootOf(shell) {
    try {
      const editor = shell.editor;
      if (editor === null || editor === undefined || typeof editor.getRootElement !== 'function') return null;
      return editor.getRootElement() ?? null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * 记住某个会话最近一次非空草稿。
   * 宿主 store 抛错不能外溢——这里紧贴 React 的提交阶段，异常会直接把输入框渲染搞挂。
   * @param {string} sessionId - 会话标识
   * @param {object} state - 宿主的快照 store
   * @returns {() => void}
   */
  function rememberOf(sessionId, state) {
    return () => {
      if (closed || !mounted.has(sessionId)) return;
      try {
        const snapshot = typeof state.getSnapshot === 'function' ? state.getSnapshot() : undefined;
        const draft = snapshot === null || snapshot === undefined ? undefined : snapshot.draft;
        if (typeof draft === 'string' && draft.trim() !== '') lastNonEmpty.set(sessionId, draft);
      } catch (error) {
        warnOnce(t('composer.snapshotFailed', { sessionId }), error);
      }
    };
  }

  /**
   * 注销某个会话：收回订阅、清掉草稿缓存，后续按键不再被本会话接管。
   * @param {string} sessionId - 会话标识
   * @returns {void}
   */
  function unmountSession(sessionId) {
    if (typeof sessionId !== 'string') return;
    mounted.delete(sessionId);
    lastNonEmpty.delete(sessionId);
    for (const stop of sessionStops.get(sessionId) ?? []) {
      try {
        if (typeof stop === 'function') stop();
      } catch (error) {
        warnOnce(t('composer.unsubscribeFailed', { sessionId }), error);
      }
    }
    sessionStops.delete(sessionId);
  }

  return {
    /**
     * 报告某个会话的输入框已挂载，并开始跟踪它最近一次非空草稿。
     * 重复调用是幂等的（组件重渲染会重复触发）。
     * @param {string} sessionId - 会话标识
     * @returns {void}
     */
    mount(sessionId) {
      if (closed || typeof sessionId !== 'string' || mounted.has(sessionId)) return;
      try {
        mounted.add(sessionId);
        const shell = shellOf(sessionId);
        const state = shell === null ? undefined : shell.state;
        if (state === null || state === undefined || typeof state.subscribe !== 'function') return;
        const remember = rememberOf(sessionId, state);
        remember();
        const stop = state.subscribe(remember);
        sessionStops.set(sessionId, typeof stop === 'function' ? [stop] : []);
      } catch (error) {
        warnOnce(t('composer.subscribeFailed', { sessionId }), error);
      }
    },

    /**
     * 注销某个会话的登记（槽位组件卸载时调用）。
     * @param {string} sessionId - 会话标识
     * @returns {void}
     */
    unmount(sessionId) {
      unmountSession(sessionId);
    },

    /**
     * 找出按键落在哪个会话的输入框上。
     * 用输入框自己的根元素做归属，分屏/右栏并排出现多个 composer 时也不会串会话。
     * @param {unknown} target - 事件落点元素
     * @returns {string|null}
     */
    sessionOfTarget(target) {
      if (target === null || target === undefined) return null;
      for (const sessionId of mounted) {
        const root = rootOf(shellOf(sessionId));
        if (root === null) continue;
        if (root === target) return sessionId;
        try {
          if (typeof root.contains === 'function' && root.contains(target)) return sessionId;
        } catch (_error) {
          // 落点不是节点时 contains 会抛，跳过这个会话即可
        }
      }
      return null;
    },

    /**
     * 按会话取输入外壳。
     * @param {string} sessionId - 会话标识
     * @returns {object|null}
     */
    shellOf,

    /**
     * 读当前草稿。
     * text 是给人看的文本（引用 chip 展开成 @xxx），detectText 与 caret 同坐标系（chip 是占位符），
     * snapshot 是原样写回用的载荷：草稿里有引用 chip 时带上 references，避免翻历史把用户的引用吃掉。
     * @param {object} shell - 输入外壳
     * @returns {{text: string, detectText: string, caret: number|null, snapshot: unknown}|null}
     */
    readDraft(shell) {
      if (closed) return null;
      try {
        const projection = shell.projection;
        if (projection === null || projection === undefined) return null;
        const text = typeof projection.clipboardText === 'string' ? projection.clipboardText : '';
        const detectText = typeof projection.detectText === 'string' ? projection.detectText : text;
        const caret = typeof projection.caret === 'number' ? projection.caret : null;
        const references = Array.isArray(projection.occurrences) ? projection.occurrences : [];
        const snapshot = references.length === 0 ? text : { text, references };
        return { text, detectText, caret, snapshot };
      } catch (error) {
        warnOnce(t('composer.readFailed'), error);
        return null;
      }
    },

    /** 写回草稿，并通过编辑器公开接口把折叠光标定位到文首。 */
    writeDraft(shell, value) {
      if (closed) return false;
      try {
        const actions = shell.actions;
        if (actions === null || actions === undefined || typeof actions.setDraft !== 'function') return false;
        actions.setDraft(value);
        const editor = shell.editor;
        if (editor !== null && editor !== undefined && typeof editor.getEditorState === 'function' &&
            typeof editor.setEditorState === 'function' && typeof editor.focus === 'function') {
          const state = editor.getEditorState();
          if (state !== null && state !== undefined && typeof state.clone === 'function') {
            // focus 的 rootStart 只在选区缺失时生效；clone(null) 保留内容，只清除旧选区。
            editor.setEditorState(state.clone(null));
            editor.focus(undefined, { defaultSelection: 'rootStart' });
          }
        }
        return true;
      } catch (error) {
        warnOnce(t('composer.writeFailed'), error);
        return false;
      }
    },

    /**
     * 取某会话最近一次非空草稿（回车发送时真正发出去的那段文本）。
     * @param {string} sessionId - 会话标识
     * @returns {string|null}
     */
    lastNonEmptyDraftOf(sessionId) {
      const draft = lastNonEmpty.get(sessionId);
      return typeof draft === 'string' ? draft : null;
    },

    /**
     * 收回所有会话的订阅。
     * @returns {void}
     */
    dispose() {
      if (closed) return;
      closed = true;
      for (const sessionId of [...sessionStops.keys()]) unmountSession(sessionId);
      mounted.clear();
      lastNonEmpty.clear();
      sessionStops.clear();
    },
  };
}
