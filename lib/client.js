window.__ModuleLoader__.load({id:"dsh-replay",factory:(require)=>{
const React = require('react');
/**
 * 输入历史状态机。
 *
 * 这里只维护「每个会话一条历史栈 + 一个回翻游标 + 一份翻历史前的草稿」，
 * 不碰 DOM、不碰 React、不认识宿主服务，所以 node --test 能直接 import 验证边界
 * （翻到最旧停住、回到原草稿、会话之间互不串）。
 */

/**
 * 默认保留已按需加载的完整历史，保证 ↑ 能继续回翻且 ↓ 能返回每条及原草稿。
 * 显式 options.limit 才裁剪最旧条目；它是自定义内存保护，也会限制可回翻范围。
 */
const DEFAULT_LIMIT = Infinity;

/**
 * 判断光标是否落在首行。
 *
 * caret 是 detect 文本里的字符偏移；宿主的 $composerLayout 用单个 "\n" 表示段落之间的间隔，
 * 引用 chip 在 detect 文本里是占位符（宽度 1），所以「光标之前有没有换行」就是「在不在首行」。
 *
 * @param {string} text - 与 caret 同一坐标系下的文本
 * @param {number} caret - 折叠光标的字符偏移
 * @returns {boolean} 光标在首行（或文本还没有换行）时为真
 */
function isFirstLine(text, caret) {
  if (typeof text !== 'string') return false;
  if (typeof caret !== 'number' || !Number.isInteger(caret) || caret < 0 || caret > text.length) return false;
  return text.slice(0, caret).indexOf('\n') === -1;
}

/**
 * 判断这次 ↑ 该不该翻历史。
 *
 * 只有两种情形允许接管：输入框是空的，或者光标在首行。其余一律让原生光标上移继续走。
 * 有选区时（caret 为 null）不接管：此时 ↑ 的语义是把选区折叠到开头，跟历史无关。
 *
 * @param {string} text - 输入框当前文本
 * @param {number|null} caret - 折叠光标偏移，有选区时为 null
 * @returns {boolean}
 */
function isRecallTrigger(text, caret) {
  if (typeof text !== 'string') return false;
  if (text.trim() === '') return true;
  if (caret === null || caret === undefined) return false;
  return isFirstLine(text, caret);
}

/**
 * 把会话记录里的历史与内存记录合成一条栈。
 *
 * 会话记录里的排在前面（更旧），插件运行期间记的追加在后面；
 * 同一段文本连续出现只留一条——与 push 的去重口径一致，否则同一条消息会在栈里占两格。
 * 超过上限时丢最旧的，栈顶永远是最新那条（up() 依赖这个顺序）。
 *
 * @param {unknown[]} older - 会话记录里读到的文本，按时间升序
 * @param {string[]} newer - 内存里记的文本，按时间升序
 * @param {number} limit - 每会话保留条数上限
 * @returns {string[]}
 */
function mergeTexts(older, newer, limit) {
  const merged = [];
  for (const text of [...older, ...newer]) {
    if (typeof text !== 'string' || text.trim() === '') continue;
    if (merged.length > 0 && merged[merged.length - 1] === text) continue;
    merged.push(text);
  }
  if (merged.length > limit) merged.splice(0, merged.length - limit);
  return merged;
}

/**
 * 建一个输入历史仓库。
 * @param {{limit?: number, i18n?: object}} options - 显式 limit 限制每会话保留条数，默认不裁剪
 * @returns 历史仓库
 */
function createHistory(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  /**
   * sessionId -> { entries, cursor, stash, hydrating, hydrated, warned }
   * hydrating/hydrated 管「会话记录只拉一次」，warned 管「失败只吵一次」。
   */
  const sessions = new Map();
  let closed = false;
  const t = (key, params) => typeof options.i18n?.t === 'function' ? options.i18n.t(key, params) : key;

  function slotOf(sessionId) {
    let slot = sessions.get(sessionId);
    if (slot === undefined) {
      slot = {
        entries: [],
        cursor: null,
        stash: null,
        hydrating: false,
        hydrated: false,
        warned: false,
        /** 上次会话记录快照的条数：用来算出「这次多加载出来的更早部分」。 */
        sessionCount: 0,
        /** 向上翻页在途：防止连续按 ↑ 时并发发起多次加载。 */
        loadingMore: false,
        /** 会话记录已经翻到头：不用再请求了。 */
        exhausted: false,
      };
      sessions.set(sessionId, slot);
    }
    return slot;
  }

  return {
    /**
     * 记一条「已经发出去的输入」。
     * 空白文本不入栈；与上一条重复也不入栈（同一条消息连按两次 Enter 时不会重复占位）。
     * 新记录会让回翻游标归零，避免在旧栈位置上继续翻。
     * @param {string} sessionId - 会话标识
     * @param {string} text - 发送时输入框里的文本
     * @returns {boolean} 是否真的入栈
     */
    push(sessionId, text) {
      if (closed || typeof sessionId !== 'string' || typeof text !== 'string') return false;
      if (text.trim() === '') return false;
      const slot = slotOf(sessionId);
      if (slot.entries.length > 0 && slot.entries[slot.entries.length - 1] === text) {
        slot.cursor = null;
        slot.stash = null;
        return false;
      }
      slot.entries.push(text);
      if (slot.entries.length > limit) slot.entries.splice(0, slot.entries.length - limit);
      slot.cursor = null;
      slot.stash = null;
      return true;
    },

    /**
     * 用会话记录里的历史回填该会话的历史栈。
     *
     * 调用点是「会话输入框挂载」（history-client.js 的 composer.dock 挂载回调），不在按键路径：
     * 这样用户第一次按 ↑ 时栈已经是完整的，不会出现「先只翻到 1 条、回填完游标又被复位」。
     * 已初始化过的会话不再重复拉取；拉取在途时重复调用（重复挂载）也不会并发发起第二次。
     * 失败只 warn 一次并保持内存行为——回填是锦上添花，绝不能挡住挂载，也不能抛给调用方。
     *
     * @param {string} sessionId - 会话标识
     * @param {(sessionId: string) => Promise<string[]>} loader - 读会话记录的函数（注入以便测试与降级）
     * @returns {Promise<boolean>} 是否真的回填成功
     */
    async hydrate(sessionId, loader) {
      if (closed || typeof sessionId !== 'string') return false;
      if (typeof loader !== 'function') return false;
      const slot = slotOf(sessionId);
      if (slot.hydrated || slot.hydrating) return false;
      slot.hydrating = true;
      let filled = false;
      /** 会话记录里真正读到的条数：决定这次算不算「初始化成功」。 */
      let loaded = 0;
      try {
        const result = await loader(sessionId);
        if (closed) return false;
        const texts = Array.isArray(result) ? result : Array.isArray(result && result.texts) ? result.texts : [];
        loaded = texts.length;
        // 记下用户此刻正在看的那一条：回填是异步的，完成时用户可能已经在翻历史了，
        // 无条件复位游标会把「他正看着的那一条」抽走，表现成「按 ↑ 又跳回最新」。
        const viewing = slot.cursor === null ? null : slot.entries[slot.cursor];
        // 会话记录是权威来源（它已包含插件运行期间发过的消息），读到东西就整体替换；
        // 合并会让人工记的那条与记录里的同一条在栈里占两格。
        if (loaded > 0) slot.entries = mergeTexts(texts, [], limit);
        slot.sessionCount = loaded;
        slot.exhausted = Array.isArray(result) ? false : result !== null && typeof result === 'object' && result.hasMore === false;
        if (viewing === null) {
          // 没在回翻：栈变了，旧草稿槽位作废，下一次 ↑ 从最新一条开始
          slot.stash = null;
        } else {
          // 正在回翻：把游标重新锚定到同一条文本，锚不住才退出回翻
          const anchor = slot.entries.lastIndexOf(viewing);
          slot.cursor = anchor >= 0 ? anchor : null;
          if (slot.cursor === null) slot.stash = null;
        }
        filled = true;
      } catch (error) {
        // 读取失败允许重挂载再试，但同一仓库只告警一次；原始宿主错误另传。
        if (!closed && slot.warned === false) {
          slot.warned = true;
          console.warn(t('history.readFailed', { sessionId }), error);
        }
      } finally {
        if (!closed) {
          slot.hydrating = false;
          // 空窗口仍允许下次挂载回填，不把尚在加载的会话锁死。
          slot.hydrated = filled === true && loaded > 0;
        }
      }
      return filled;
    },

    /**
     * 再向上翻一页更早的会话历史（懒加载）。
     *
     * 调用点是「已经翻到栈里最早一条时又按了 ↑」：一次只补一页，翻不完下次再补，
     * 默认不裁剪已加载条目，用户可继续翻到会话开头，再逐条 ↓ 返回原草稿。
     * 与 hydrate 的区别：不看 hydrated 锁（那是「首次回填只做一次」的锁），只受 loadingMore / exhausted 约束。
     *
     * @param {string} sessionId - 会话标识
     * @param {(sessionId: string) => Promise<string[]|{texts: string[], hasMore?: boolean}>} loader - 读会话记录
     * @returns {Promise<boolean>} 这次是否真的补进了更早的历史
     */
    async loadMore(sessionId, loader) {
      if (closed || typeof sessionId !== 'string') return false;
      if (typeof loader !== 'function') return false;
      const slot = slotOf(sessionId);
      if (slot.loadingMore || slot.exhausted) return false;
      slot.loadingMore = true;
      let added = 0;
      try {
        const result = await loader(sessionId);
        if (closed) return false;
        const texts = Array.isArray(result) ? result : Array.isArray(result && result.texts) ? result.texts : [];
        // texts 是累积快照：比上次多出来的那段就是这次新加载的更早历史，位于数组前部
        const fresh = texts.slice(0, Math.max(0, texts.length - slot.sessionCount));
        slot.sessionCount = Math.max(slot.sessionCount, texts.length);
        if (Array.isArray(result)) slot.exhausted = false;
        else if (result !== null && typeof result === 'object' && result.hasMore === false) slot.exhausted = true;
        if (fresh.length > 0) {
          const viewing = slot.cursor === null ? null : slot.entries[slot.cursor];
          const previousLength = slot.entries.length;
          slot.entries = mergeTexts(fresh, slot.entries, limit);
          added = slot.entries.length - previousLength;
          if (viewing !== null) {
            // 新历史插到了前面，游标要跟着挪，否则用户会突然看到另一条
            const anchor = slot.entries.lastIndexOf(viewing);
            slot.cursor = anchor >= 0 ? anchor : null;
            if (slot.cursor === null) slot.stash = null;
          }
        }
      } catch (error) {
        if (!closed && slot.warned === false) {
          slot.warned = true;
          console.warn(t('history.loadMoreFailed', { sessionId }), error);
        }
      } finally {
        if (!closed) slot.loadingMore = false;
      }
      return added > 0;
    },

    /**
     * 是否已经翻到栈里最早一条（此时再按 ↑ 就该向上翻页了）。
     * @param {string} sessionId - 会话标识
     * @returns {boolean}
     */
    atOldest(sessionId) {
      const slot = sessions.get(sessionId);
      return slot !== undefined && slot.cursor === 0;
    },

    /**
     * 会话记录是否还可能有更早的历史（翻到头之后就不必再请求）。
     * @param {string} sessionId - 会话标识
     * @returns {boolean}
     */
    canLoadMore(sessionId) {
      const slot = sessions.get(sessionId);
      return slot !== undefined && slot.exhausted !== true;
    },

    /**
     * 往前翻一条（↑）。
     * 第一次调用把当前草稿原样存进槽位，然后给出最旧的一条；到最旧之后停在最旧，不循环、不清空。
     * @param {string} sessionId - 会话标识
     * @param {unknown} currentDraft - 翻历史前正在编辑的草稿，供 ↓ 恢复
     * @returns {string|null} 要写回输入框的历史文本；没有历史时返回 null
     */
    up(sessionId, currentDraft) {
      if (closed) return null;
      const slot = slotOf(sessionId);
      if (slot.entries.length === 0) return null;
      if (slot.cursor === null) {
        slot.stash = currentDraft;
        slot.cursor = slot.entries.length - 1;
        return slot.entries[slot.cursor];
      }
      if (slot.cursor > 0) slot.cursor -= 1;
      return slot.entries[slot.cursor];
    },

    /**
     * 往后翻一条（↓）。
     * 越过最新一条时交还翻历史前那份草稿并把游标复位；不在回翻状态时返回 null（此时不接管 ↓）。
     * @param {string} sessionId - 会话标识
     * @returns {unknown|null} 要写回输入框的内容；null 表示这次不接管
     */
    down(sessionId) {
      const slot = sessions.get(sessionId);
      if (slot === undefined || slot.cursor === null) return null;
      if (slot.cursor < slot.entries.length - 1) {
        slot.cursor += 1;
        return slot.entries[slot.cursor];
      }
      const draft = slot.stash;
      slot.cursor = null;
      slot.stash = null;
      return draft === null || draft === undefined ? '' : draft;
    },

    /**
     * 退出回翻状态，丢掉草稿槽位（用户自己改了草稿，或会话不再可用时调用）。
     * @param {string} sessionId - 会话标识
     * @returns {void}
     */
    reset(sessionId) {
      const slot = sessions.get(sessionId);
      if (slot === undefined) return;
      slot.cursor = null;
      slot.stash = null;
    },

    /**
     * 是否正在回翻历史（决定 ↓ 能不能接管）。
     * @param {string} sessionId - 会话标识
     * @returns {boolean}
     */
    isBrowsing(sessionId) {
      const slot = sessions.get(sessionId);
      return slot !== undefined && slot.cursor !== null;
    },

    /**
     * 读某个会话的历史副本（只读，供测试与诊断使用）。
     * @param {string} sessionId - 会话标识
     * @returns {string[]}
     */
    entries(sessionId) {
      const slot = sessions.get(sessionId);
      return slot === undefined ? [] : slot.entries.slice();
    },

    dispose() {
      if (closed) return;
      closed = true;
      sessions.clear();
    },
  };
}

/**
 * 按键意图判定：把宿主 fixed-input 的观察结果翻译成「往前翻 / 往后翻 / 记一条 / 不动」。
 *
 * 纯函数，无 DOM、无 React，便于直接测。判定顺序本身就是安全策略：
 * 先确认没被别处消费，再确认焦点在输入框里，最后才看草稿内容。
 */

/** 观察结果里的输入类型：只有真实的 keydown 才算，reset 是宿主的重置广播。 */
const KEYDOWN = 'keydown';

/**
 * 把一次观察结果分类。
 *
 * 顺序不可调换：
 * 1. reset / 组合输入 / 带修饰键 / 非方向键与回车 → 一律不动；
 * 2. gesture.defaultPrevented 为真说明 Lexical 或输入框浮层（命令菜单、@ 列表）已经处理过这个键，
 *    此时必须让路——这正是「不抢键」的根基；
 * 3. 焦点不在可编辑区域（context.region 不是 editable）→ 让路。
 *
 * 不看 context.modal：它由「页面上是否存在 aria-modal 容器」决定，设置页关闭后 DOM 残留也会让它恒非空，
 * 据此让路会让整个功能瘫痪（实机踩过）。焦点已在可编辑区、且按键落在本插件 composer 内，弹窗判定是多余的。
 *
 * @param {unknown} input - observeFixedInput 交给监听者的原始输入
 * @returns {{kind: 'prev'|'next'|'record', reason?: undefined}|{kind: 'skip', reason: string}}
 */
function classifyInput(input) {
  if (input === null || typeof input !== 'object') return { kind: 'skip', reason: 'no-input' };
  if (input.type !== KEYDOWN) return { kind: 'skip', reason: 'not-keydown' };
  const gesture = input.gesture;
  if (gesture === null || typeof gesture !== 'object') return { kind: 'skip', reason: 'no-gesture' };
  const context = input.context;
  if (context === null || typeof context !== 'object') return { kind: 'skip', reason: 'no-context' };
  if (gesture.composing === true) return { kind: 'skip', reason: 'composing' };
  // 刻意不看 context.modal：宿主用 querySelectorAll(modalSelector) 取最后一个来判定「有没有弹窗」，
  // 而设置页本身就是 aria-modal="true" 的对话框（dsh-client-ui-settings-general/lib/client.js:290），
  // 只要它的 DOM 还挂在页面上（关闭后也可能残留），modal 就恒不为 null——据此让路会让整个功能彻底瘫痪。
  // 按键已经由 region === 'editable' 与「落在本插件 composer 内」双重确认，不需要再看弹窗。
  if (context.region !== 'editable') return { kind: 'skip', reason: 'region' };

  if (gesture.code === 'ArrowUp' || gesture.code === 'ArrowDown') {
    // 方向键：Shift 是扩选、Alt/Ctrl/Meta 是别的语义，都不归历史管
    if (gesture.shift === true || gesture.alt === true || gesture.control === true || gesture.meta === true) {
      return { kind: 'skip', reason: 'modifier' };
    }
    if (gesture.defaultPrevented === true) return { kind: 'skip', reason: 'consumed' };
    return { kind: gesture.code === 'ArrowUp' ? 'prev' : 'next' };
  }

  if (gesture.code === 'Enter') {
    // 回车：宿主在 Lexical 命令里必定 preventDefault，所以这里刻意不判 defaultPrevented，
    // 否则历史永远记不到东西。排除的组合严格对齐宿主的回车处理器
    // （dsh-client-ui-conversation/lib/client.js:18236-18237）：
    //   Shift+Enter 换行、Alt/AltGraph 不动草稿、Ctrl 与 Meta 同时按下被宿主直接吞掉。
    // 单独的 Ctrl+Enter / Cmd+Enter 是「另一种发送模式」（:18246 submit(true)），必须记。
    if (gesture.shift === true || gesture.alt === true) return { kind: 'skip', reason: 'modifier' };
    if (gesture.control === true && gesture.meta === true) return { kind: 'skip', reason: 'modifier' };
    if (gesture.repeat === true) return { kind: 'skip', reason: 'repeat' };
    return { kind: 'record' };
  }

  return { kind: 'skip', reason: 'other-key' };
}

/**
 * 在「已经确认落在某个会话的输入框」之后，结合草稿与回翻状态决定动不动手。
 *
 * 回翻中（browsing）时不再要求光标在首行：此时光标是我们自己写回后落在末尾的，
 * 多行历史条目按完 ↑ 光标可能已经在第 N 行，若还按首行判定就翻不动了。
 *
 * @param {'prev'|'next'} direction - 方向
 * @param {{text: string, caret: number|null, browsing: boolean}} state - 当前草稿与回翻状态
 * @returns {{act: boolean, reason?: string}}
 */
function decideAction(direction, state) {
  if (direction === 'prev') {
    if (state.browsing) return { act: true };
    if (typeof state.text === 'string' && state.text.trim() === '') return { act: true };
    if (state.caret === null || state.caret === undefined) return { act: false, reason: 'selection' };
    const head = typeof state.text === 'string' ? state.text.slice(0, state.caret) : '';
    if (head.indexOf('\n') !== -1) return { act: false, reason: 'not-first-line' };
    return { act: true };
  }
  if (direction === 'next') {
    return state.browsing ? { act: true } : { act: false, reason: 'not-browsing' };
  }
  return { act: false, reason: 'unknown-direction' };
}

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
function createComposers(conversation, i18n) {
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

/**
 * 从消息内容里取纯文本。
 *
 * 新事件是 PromptContentPart[]，与宿主 contentParts() 同构：只拼 type==='text' 的段。
 * 旧会话（插件安装之前就写进日志的事件）可能把内容直接存成字符串，那种也必须读得出文本，
 * 否则旧消息既没有重试图标、也进不了输入历史。
 * 图片/文件附件不参与——重发只重发文本，把附件再传一遍等于二次上传。
 * 引用 chip 在内容里本来就是内联文本（形如 @src/a.js），原样保留即可。
 *
 * @param {unknown} content - 消息内容（内容段数组、纯字符串或缺失）
 * @returns {string}
 */
function extractPromptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

/**
 * 判断一条事件是不是「用户自己发的一句对话」。
 *
 * 与宿主内置 input-message 的判定同口径（ui-chat 的 messageDefinition.match），但对旧会话宽松：
 * 插件安装之前产生的事件可能完全没有 surfaceOp、没有 data.source、没有 data.id，
 * 一律按「用户追加发送」处理——否则旧对话里的旧消息永远拿不到重试图标（用户实测的缺陷）。
 * 保留的两条硬条件：type 必须是 user/message，data 必须是对象。
 *
 * @param {unknown} event - 会话事件
 * @returns {boolean}
 */
function isUserPromptEvent(event) {
  if (event === null || typeof event !== 'object') return false;
  if (event.type !== 'user/message') return false;
  // 只有显式的替换副本才排除：压缩检查点、被改写的历史都不是用户当时看到的那条
  if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return false;
  const data = event.data;
  if (data === null || typeof data !== 'object') return false;
  // 工具注入的上下文（tool-registry / runtime-context）不是「用户发的话」，必须挡住；
  // 旧事件根本没有 source 字段，缺失按用户消息放行
  const source = data.source;
  if (source !== null && typeof source === 'object' && source.kind !== undefined && source.kind !== 'user') return false;
  return true;
}

/**
 * 事件身份：新事件用 data.id，旧事件没有 id 时退回 seq。
 *
 * 必须是稳定值——宿主拿它拼 context key，同一事件两次匹配给出不同 id 会每次都造一个新 context。
 *
 * @param {unknown} event - 会话事件
 * @returns {string|null} 拿不到稳定身份时返回 null
 */
function userPromptIdOf(event) {
  const data = event === null || typeof event !== 'object' ? undefined : event.data;
  const id = data === null || typeof data !== 'object' ? undefined : data.id;
  if (id !== null && id !== undefined) return String(id);
  const seq = event === null || typeof event !== 'object' ? undefined : event.seq;
  return typeof seq === 'number' ? 'seq-' + seq : null;
}

/**
 * 用户消息的纯文本：重试图标与输入历史回填共用这一份提取口径。
 *
 * @param {unknown} event - 会话事件
 * @returns {string} 不是用户消息时返回空串
 */
function userPromptTextOf(event) {
  if (isUserPromptEvent(event) === false) return '';
  return extractPromptText(event.data.content);
}

const LOCALES = Object.freeze({
  zh: Object.freeze({
    'brand.name': '回言',
    'brand.description': '按会话回翻输入历史，或将用户消息原样追加重发。',
    'component.history.name': '输入历史',
    'component.history.description': '用 ↑/↓ 回翻当前会话的输入历史，保留草稿与原生光标行为。',
    'component.retry.name': '消息重试',
    'component.retry.description': '在用户消息操作行追加重试按钮，重发到对话末尾，不改动已有对话。',
    'copy.label': '复制',
    'copy.done': '已复制',
    'copy.title': '复制这条消息',
    'retry.failure': '重发失败',
    'retry.empty': '这条消息没有可重发的文本',
    'retry.unavailable': '会话不可用，无法重发',
    'retry.disabled': '消息重试组件已停用',
    'retry.label': '重试这条消息',
    'retry.busy': '正在生成回答，等这一轮结束后再重发',
    'retry.sending': '正在重发…',
    'retry.title': '把这条消息再发一次：追加到对话末尾，已有对话一字不动',
    'clock.md': '{m}月{d}日',
    'clock.ymd': '{y}年{m}月{d}日',
    'history.prev': '上一条输入',
    'history.next': '下一条输入',
    'history.missingSession': '[dsh-replay] composer.dock 槽位没有拿到 sessionId，输入历史在该会话不可用',
    'history.unavailable': '会话还没有打开，读不到历史',
    'history.pageFailed': '[dsh-replay] 向上翻页读取更早历史失败，只用已加载部分：{sessionId}',
    'history.hydrated': '[dsh-replay] 会话历史回填',
    'history.draftChanged': '[dsh-replay] 退出回翻：草稿与上次写入不一致',
    'history.unregisterFailed': '[dsh-replay] 解注册失败',
    'history.fixedFailed': '[dsh-replay] 快捷键清单声明失败',
    'history.readFailed': '[dsh-replay] 读取会话历史失败，该会话退回只记插件运行期间的输入：{sessionId}',
    'history.loadMoreFailed': '[dsh-replay] 加载更早的会话历史失败：{sessionId}',
    'history.moreFailed': '[dsh-replay] 加载更早的会话历史失败：{sessionId}',
    'history.mountFailed': '[dsh-replay] 输入历史装配失败',
    'composer.shellFailed': '[dsh-replay] 解析输入外壳失败，输入历史在该会话不可用',
    'composer.snapshotFailed': '[dsh-replay] 读取草稿快照失败，回车记历史暂停',
    'composer.unsubscribeFailed': '[dsh-replay] 解订阅失败',
    'composer.subscribeFailed': '[dsh-replay] 订阅草稿快照失败，回车记历史在该会话暂停',
    'composer.readFailed': '[dsh-replay] 读取草稿失败',
    'composer.writeFailed': '[dsh-replay] 写回草稿失败',
  }),
  en: Object.freeze({
    'brand.name': 'Re:Play',
    'brand.description': 'Recall per-session input history or resend user messages by appending them unchanged.',
    'component.history.name': 'Input history',
    'component.history.description': 'Use ↑/↓ to recall input history in the current session while preserving drafts and native cursor behavior.',
    'component.retry.name': 'Prompt Replay',
    'component.retry.description': 'Add a retry action to user messages and resend at the end without changing the existing conversation.',
    'copy.label': 'Copy',
    'copy.done': 'Copied',
    'copy.title': 'Copy this message',
    'retry.failure': 'Resend failed',
    'retry.empty': 'This message has no text to resend',
    'retry.unavailable': 'The session is unavailable; cannot resend',
    'retry.disabled': 'The message retry component is disabled',
    'retry.label': 'Retry this message',
    'retry.busy': 'A response is being generated. Wait for this turn to finish before resending',
    'retry.sending': 'Resending…',
    'retry.title': 'Send this message again: append it to the end, leaving the existing conversation unchanged',
    'clock.md': '{m}/{d}',
    'clock.ymd': '{y}-{m}-{d}',
    'history.prev': 'Previous input',
    'history.next': 'Next input',
    'history.missingSession': '[dsh-replay] composer.dock did not provide sessionId; input history is unavailable in this session',
    'history.unavailable': 'The session is not open; history is unavailable',
    'history.pageFailed': '[dsh-replay] Failed to read older history; using only loaded entries: {sessionId}',
    'history.hydrated': '[dsh-replay] Session history hydrated',
    'history.draftChanged': '[dsh-replay] Stopped history recall: the draft no longer matches the last written value',
    'history.unregisterFailed': '[dsh-replay] Failed to unregister',
    'history.fixedFailed': '[dsh-replay] Failed to declare fixed shortcuts',
    'history.readFailed': '[dsh-replay] Failed to read session history; recording only inputs made while the plugin is running: {sessionId}',
    'history.loadMoreFailed': '[dsh-replay] Failed to load older session history: {sessionId}',
    'history.moreFailed': '[dsh-replay] Failed to load older session history: {sessionId}',
    'history.mountFailed': '[dsh-replay] Failed to mount input history',
    'composer.shellFailed': '[dsh-replay] Failed to resolve the input shell; input history is unavailable in this session',
    'composer.snapshotFailed': '[dsh-replay] Failed to read the draft snapshot; recording history on Enter is paused',
    'composer.unsubscribeFailed': '[dsh-replay] Failed to unsubscribe',
    'composer.subscribeFailed': '[dsh-replay] Failed to subscribe to draft snapshots; recording history on Enter is paused in this session',
    'composer.readFailed': '[dsh-replay] Failed to read the draft',
    'composer.writeFailed': '[dsh-replay] Failed to restore the draft',
  }),
});

function languageOf(language) {
  return typeof language === 'string' && /^zh(?:-|$)/i.test(language) ? 'zh-CN' : 'en-US';
}

function translateReplay(key, language, params) {
  const dict = languageOf(language) === 'zh-CN' ? LOCALES.zh : LOCALES.en;
  const template = Object.hasOwn(dict, key) ? dict[key] : key;
  return interpolate(template, params);
}

function interpolate(template, params) {
  return params ? template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match) : template;
}

function createReplayI18n(locale) {
  if (locale != null) {
    for (const method of ['getSnapshot', 'resolveText', 'subscribe']) {
      if (typeof locale[method] !== 'function') throw new TypeError(`Replay locale requires ${method}()`);
    }
  }
  const language = () => languageOf(locale?.getSnapshot().active);
  const stops = new Set();
  let disposed = false;
  return {
    t(key, params) {
      if (!Object.hasOwn(LOCALES.en, key)) return key;
      if (!locale) return translateReplay(key, language(), params);
      return interpolate(locale.resolveText({ zh: LOCALES.zh[key], en: LOCALES.en[key] }), params);
    },
    language,
    subscribe(fn) {
      if (disposed) throw new Error('Replay i18n is disposed');
      if (!locale) return () => {};
      const hostOff = locale.subscribe(() => fn());
      const stop = () => {
        if (!stops.has(stop)) return;
        hostOff();
        stops.delete(stop);
      };
      stops.add(stop);
      return stop;
    },
    dispose() {
      disposed = true;
      for (const stop of stops) stop();
    },
  };
}

/**
 * 剪贴板写入：插件里唯一允许碰 document 的地方。
 *
 * 宿主自己的复制按钮走 primitives 的 writeClipboard（web shell @660099），而插件被明令禁止
 * import primitives，只能把那段行为抄过来：优先 navigator.clipboard.writeText，
 * 不可用再回落「临时 textarea + document.execCommand('copy')」。
 *
 * 回落路径用 document，但只是瞬时建一个离屏 textarea、复制完立刻移除：
 * 不常驻、不读也不改宿主的任何 DOM 节点。scripts/check.mjs 的 document. 禁令只对本文件放行，
 * 其它文件照旧全禁——放行范围收到一个文件、一个用途，是为了不让「复制」这种小功能
 * 把整条 DOM 红线拆掉。
 */

/**
 * 把文本写进剪贴板。
 *
 * 任何失败都只回 false，不抛：复制失败不该炸掉消息行，也不该让用户以为复制成功了。
 *
 * @param {string} text - 要写入的文本
 * @returns {Promise<boolean>} 是否真的写进去了
 */
function writeClipboardText(text) {
  const value = typeof text === 'string' ? text : '';
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const clipboard = nav === null || nav === undefined ? undefined : nav.clipboard;
  if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === 'function') {
    try {
      // 异步 API 也可能被策略拒绝（非安全上下文、无用户手势），拒绝时再走回落
      return Promise.resolve(clipboard.writeText(value)).then(
        () => true,
        () => copyByTextarea(value),
      );
    } catch (error) {
      return Promise.resolve(copyByTextarea(value));
    }
  }
  return Promise.resolve(copyByTextarea(value));
}

/**
 * 回落复制：临时 textarea + execCommand。
 *
 * @param {string} value - 要写入的文本
 * @returns {boolean} 是否复制成功
 */
function copyByTextarea(value) {
  // 非浏览器环境（node --test 的 vm 沙箱）没有 document：直接判定复制不可用
  if (typeof document === 'undefined' || document === null) return false;
  if (typeof document.execCommand !== 'function') return false;
  let area;
  try {
    area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    return document.execCommand('copy') === true;
  } catch (error) {
    return false;
  } finally {
    if (area !== undefined && typeof area.remove === 'function') area.remove();
  }
}

/**
 * 「重试用户消息」：把重试图标挂进用户消息的操作行，与宿主自带的「复制」并列。
 *
 * 宿主没给操作行留插图标的口子（MessageIconActions 的 extraActions 只有宿主内部传得进去），
 * 所以只能接管 conversation.chat.node 的 'user' 格，自己写「行容器 + 操作行」。
 * 气泡本体不自己画：用 renderFactorySlot('conversation.chat.user.content') 原样复用宿主工厂，
 * 附件、引用摘要、富文本全部仍由宿主产出，宿主改版时气泡内容自动跟上。
 *
 * 这个文件只放纯逻辑（文本提取 / 时间戳）与无副作用的展示组件：
 * 不碰 DOM（剪贴板在 clipboard.js）、不认识宿主服务实例，node --test 能直接 import 验证。
 */

/** 复制成功后的复位延时：与宿主复制按钮同款 1 秒。 */
const COPIED_RESET_MS = 1e3;

/**
 * 行容器：与宿主 UserStyleBubble 的 userRow 同构——右对齐、竖向排列、气泡与操作行间隔 6px。
 * 类名由宿主 CSS 模块持有，插件不能引用，这里全部用内联样式。
 */
const ROW_STYLE = { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' };

/** 降级气泡的栈容器：抄宿主 userStack 的宽度上限（内容区 70.2%，最多 82%），右对齐。 */
const STACK_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: '8px',
  minWidth: 0,
  maxWidth: 'min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)',
};

/**
 * 降级气泡本体：只在宿主没有 conversation.chat.user.content 工厂时用。
 * 刻意只用 --dsw-alias-* 与 --dsh-* 尺寸 token，不抄宿主的 --dsw-specific-bubble：
 * 这条路径只在「宿主把工厂挪走/改名」时才走到，颜色略偏也比绑死宿主的私有 token 强。
 */
const BUBBLE_STYLE = {
  background: 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))',
  borderRadius: 'var(--dsw-radius-xl, 16px)',
  maxWidth: '100%',
  fontSize: 'var(--dsh-content-font-size, 14px)',
  lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))',
  color: 'var(--dsw-alias-label-primary, inherit)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  padding: '10px 16px',
};

/** 操作行保留 28px 高度；图标按钮自带留白，不再额外叠加外部间隙。 */
const ACTIONS_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 0,
  height: 'calc(28px + var(--dsh-content-font-delta, 0px))',
  transition: 'opacity 80ms',
};

/** 时间与图标是不同分组，外间距隔开文字和按钮悬停背景，不扩大图标之间的间距。 */
const TIME_STYLE = {
  marginInlineEnd: '8px',
  flexShrink: 0,
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
  color: 'var(--dsw-alias-label-tertiary, #9a9a9a)',
  whiteSpace: 'nowrap',
};

/** 图标按钮：宿主 .action 的尺寸、圆角与配色。 */
const ACTION_BUTTON_STYLE = {
  boxSizing: 'border-box',
  flexShrink: 0,
  minWidth: 0,
  minHeight: 0,
  width: 'calc(28px + var(--dsh-content-font-delta, 0px))',
  height: 'calc(28px + var(--dsh-content-font-delta, 0px))',
  borderRadius: 'var(--dsw-radius-sm, 4px)',
  color: 'var(--dsw-alias-label-tertiary, #9a9a9a)',
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  margin: 0,
  padding: '6px',
  display: 'inline-flex',
  justifyContent: 'center',
  alignItems: 'center',
};

/** hover/聚焦时的提亮：宿主 .action:hover 同款。 */
const ACTION_HOVER_STYLE = {
  background: 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05))',
  color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
};

/** 图标尺寸：宿主把操作行里的 svg 定在 15px。 */
const ICON_STYLE = {
  width: 'calc(15px + var(--dsh-content-font-delta, 0px))',
  height: 'calc(15px + var(--dsh-content-font-delta, 0px))',
};

/** 失败提示：跟在图标后面，小字、不抢戏，但一定看得见。 */
const NOTE_STYLE = {
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: 'calc(18px + var(--dsh-content-font-delta-secondary, 0px))',
  color: 'var(--dsw-alias-state-error-primary, #d14343)',
};

/**
 * 自绘图标：一律 16×16 视图框、fill:none、stroke:currentColor、线宽 1，
 * 与宿主 primitives 的 *Regular 图标同一规格。path 抄自宿主同款图标
 * （见各函数注释），插件不允许 import primitives，只能自己画。
 */

/**
 * 复制图标：抄 IconCopyOutlineRegular（web shell @572448）。
 * @returns {object} React 元素
 */
function CopyIcon() {
  return React.createElement(
    'svg',
    { style: ICON_STYLE, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': 'true' },
    React.createElement('rect', {
      x: '1.52075',
      y: '4.07373',
      width: '10.3932',
      height: '10.3932',
      rx: '2',
      stroke: 'currentColor',
    }),
    React.createElement('path', {
      d: 'M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z',
      fill: 'currentColor',
    }),
  );
}

/**
 * 已复制图标：抄 IconCheckOutlineRegular（web shell @567411）。
 * @returns {object} React 元素
 */
function CheckIcon() {
  return React.createElement(
    'svg',
    { style: ICON_STYLE, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': 'true' },
    React.createElement('path', {
      d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4',
      stroke: 'currentColor',
    }),
  );
}

/**
 * 重试图标：抄 IconRefreshOutlineRegular（web shell @573215）的两条 path。
 * 选它是因为宿主 ui-chat 的消息行完全没用过这个图标，不会和内置「模型重试」行撞语义。
 * @returns {object} React 元素
 */
function RefreshIcon() {
  return React.createElement(
    'svg',
    { style: ICON_STYLE, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': 'true' },
    React.createElement('path', {
      d: 'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1',
      stroke: 'currentColor',
    }),
    React.createElement('path', { d: 'M14.4999 1.5V5.1H10.8999', stroke: 'currentColor' }),
  );
}

/**
 * 把消息内容拆成「文本 / 附件 / 其余块」，与宿主 contentParts（ui-chat:5252-5274）同构。
 * 宿主的气泡工厂只吃这个形状：text 进富文本、attachments 进图片与文件卡片、rest 进 JSON 块。
 *
 * @param {unknown} content - 消息内容（内容段数组；旧会话可能是纯字符串）
 * @returns {{text: string, attachments: Array, rest: Array}}
 */
function contentParts(content) {
  const texts = [];
  const attachments = [];
  const rest = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (block.type === 'image' && block.attachment !== undefined) {
        attachments.push({ type: 'image', image: { attachment: block.attachment } });
      } else if (block.type === 'file' && block.attachment !== undefined) {
        attachments.push({ type: 'file', file: block.attachment });
      } else rest.push(block);
    }
  } else if (typeof content === 'string') {
    // 插件安装之前的旧会话把内容直接存成字符串，降级气泡也要读得出来
    texts.push(content);
  }
  return { text: texts.join(''), attachments, rest };
}

/**
 * 这一格要不要给重试图标。
 *
 * 渲染器拿到的是 chat 视图节点（{key, kind, id, anchorSeq, data}），不是原始事件，
 * 所以把 data 装回事件壳子里再走 isUserPromptEvent——口径与输入历史回填、旧会话兼容
 * 完全同一份，不在两个地方各写一套 source 判定。
 * node.kind 再卡一道：steering 是「回合进行中的插话」，把它追加重发一次语义不清晰。
 *
 * @param {unknown} node - chat 视图节点
 * @returns {boolean}
 */
function isRetryableUserNode(node) {
  if (node === null || typeof node !== 'object') return false;
  if (node.kind !== 'user') return false;
  return isUserPromptEvent({ type: 'user/message', data: node.data });
}

/**
 * 把宿主/运行时抛出来的失败对象翻译成一句人话。
 * @param {unknown} error - RemoteFailure 或 Error
 * @returns {string}
 */
function describeFailure(error, i18n) {
  const prefix = i18n.t('retry.failure');
  const english = /^en/i.test(i18n.language());
  if (error === null || typeof error !== 'object') return prefix;
  if (typeof error.message === 'string' && error.message !== '') return prefix + (english ? ': ' : '：') + error.message;
  if (typeof error.code === 'string' && error.code !== '') return prefix + (english ? ' (' : '（') + error.code + (english ? ')' : '）');
  return prefix;
}

/**
 * 构造「重发这条消息」的发送动作。
 *
 * 会话对象只能从 ctx.sessions.binding(sessionId).session 拿（ui-chat:13236-13238 也是这么取的）。
 * @param {unknown} sessions - 宿主的 sessions 服务
 * @returns {{send: (sessionId: string, text: string) => Promise<{ok: boolean, message?: string}>}}
 */
function createRetryAction(sessions, i18n, isActive = () => true) {
  return {
    async send(sessionId, text) {
      if (!isActive()) return { ok: false, messageKey: 'retry.disabled', message: i18n.t('retry.disabled') };
      const content = typeof text === 'string' ? text : '';
      if (content.trim() === '') return { ok: false, messageKey: 'retry.empty', message: i18n.t('retry.empty') };

      let binding;
      try {
        binding =
          sessions !== null && sessions !== undefined && typeof sessions.binding === 'function'
            ? sessions.binding(sessionId)
            : undefined;
      } catch (error) {
        return { ok: false, messageKey: 'retry.failure', error, message: describeFailure(error, i18n) };
      }

      const session = binding === null || binding === undefined ? undefined : binding.session;
      if (session === null || session === undefined || typeof session.prompt !== 'function') {
        return { ok: false, messageKey: 'retry.unavailable', message: i18n.t('retry.unavailable') };
      }

      if (!isActive()) return { ok: false, messageKey: 'retry.disabled', message: i18n.t('retry.disabled') };
      let result;
      try {
        // 只传文本和 mode 两个实参：requestId 留空让宿主现造（session.js:187）。
        // 复用原来的 id 会被 hasPromptRequest 幂等查重直接吞掉，点下去毫无反应。
        //
        // mode 必须是 'queue'：'steer' 会被 inbox-next-step 认领，这条消息随后渲染成 steering 行
        // （ui-chat:9868-9881），语义从「追加一次提问」变成「打断当前回答」。
        result = await session.prompt([{ type: 'text', text: content }], 'queue');
      } catch (error) {
        return { ok: false, messageKey: 'retry.failure', error, message: describeFailure(error, i18n) };
      }

      // 宿主失败不抛异常，而是把失败装进 RemoteResult（session.js:215-221），必须自己判
      if (result !== null && typeof result === 'object' && result.ok === false) {
        return { ok: false, messageKey: 'retry.failure', error: result.error, message: describeFailure(result.error, i18n) };
      }
      return { ok: true };
    },
  };
}

/**
 * 读当前 turn 是否还在生成。
 *
 * useSession 是 conversation.chat.node 的标准座 prop（ui-session 的 BUILTIN_SOURCE 提供）。
 * 它在同一个会话内恒存在或恒缺失，所以这里的条件调用不会改变 hook 顺序；
 * 万一宿主没提供，就退回「不可点」，绝不让一个装饰按钮炸掉整条消息。
 *
 * @param {unknown} useSession - 宿主的会话快照选择器 hook
 * @returns {boolean}
 */
function useSessionRunning(useSession) {
  if (typeof useSession !== 'function') return false;
  const running = useSession((snapshot) =>
    snapshot === null || typeof snapshot !== 'object' ? false : snapshot.running === true,
  );
  return running === true;
}

/** 两位数补零：时间戳的 09:05 不能写成 9:5。 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地日历日的零点毫秒：跨天判断与跨午夜刷新都按本地时区算。 */
function startOfLocalDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 距离下一个本地午夜还有多少毫秒（至少 1ms，避免 0 延迟死循环）。 */
function msUntilNextLocalMidnight(ms) {
  const next = new Date(ms);
  next.setHours(24, 0, 0, 0);
  return Math.max(next.getTime() - ms, 1);
}

/**
 * 消息时间戳：当天只给 HH:mm，今年更早给「月日 HH:mm」，跨年给「年月日 HH:mm」。
 *
 * 与宿主 formatMessageClock（ui-chat:5115-5126）同口径，自抄一份是因为它没有导出，
 * 而插件不允许 import 宿主 client-ui 包。
 *
 * @param {number} time - 事件时间（epoch ms）
 * @param {object} i18n - root 提供的 DSH 语言接口
 * @param {number} [now] - 参考时刻，默认当前时间
 * @returns {string}
 */
function formatMessageClock(time, i18n, now = Date.now()) {
  const date = new Date(time);
  const current = new Date(now);
  const clock = pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  const sameDay =
    date.getFullYear() === current.getFullYear() &&
    date.getMonth() === current.getMonth() &&
    date.getDate() === current.getDate();
  if (sameDay) return clock;
  const params = { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
  const stamp = i18n.t(date.getFullYear() === current.getFullYear() ? 'clock.md' : 'clock.ymd', params);
  return stamp + ' ' + clock;
}

/**
 * 本地日历日：跨过午夜自动前进一格，历史消息的时间戳才会从 HH:mm 变成「月日 HH:mm」。
 * 抄宿主 useCalendarDay（ui-chat:5133-5148）：先排到下一个午夜，到点刷新再续下一轮。
 *
 * @returns {number} 当前本地日历日的零点毫秒
 */
function useCalendarDay() {
  const [day, setDay] = React.useState(() => startOfLocalDay(Date.now()));
  React.useEffect(() => {
    let timer;
    const arm = () => {
      const now = Date.now();
      setDay(startOfLocalDay(now));
      timer = setTimeout(arm, msUntilNextLocalMidnight(now));
    };
    timer = setTimeout(arm, msUntilNextLocalMidnight(Date.now()));
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return day;
}

/** 自检日志的开关：只在首帧打一次，之后重渲染不再刷屏。 */
let loggedFirstRender = false;

/**
 * 首次渲染时打一条自检日志：接管成功与否、宿主有没有给工厂入口，一眼能看出来。
 * @param {boolean} hasFactory - 宿主是否提供了 renderFactorySlot
 * @returns {void}
 */
function logFirstRender(hasFactory) {
  if (loggedFirstRender === true) return;
  loggedFirstRender = true;
  console.info('[shuru] 用户消息操作行已接管', { hasFactory });
}

/**
 * 降级气泡：宿主工厂缺席时至少让人看得见这条消息说了什么。
 *
 * @param {string} text - 消息纯文本
 * @returns {object|null} React 元素；没有文本时不出气泡
 */
function renderFallbackBubble(text) {
  if (text === '') return null;
  return React.createElement(
    'div',
    { style: STACK_STYLE, 'data-shuru-bubble': 'fallback' },
    React.createElement('div', { style: BUBBLE_STYLE }, text),
  );
}

/**
 * 用户消息格：气泡（宿主工厂）+ 操作行（时间戳 / 复制 / 重试）。
 *
 * 遮蔽的是 conversation.chat.node 的 'user' 格，宿主会把这一格的完整 props 交进来：
 * node / loadImage / renderFactorySlot 来自标准座与 ownerProps，
 * sessionId / i18n / retry 由插件自己的 inject 注入。
 *
 * 失败策略：只有「连节点数据都没有」时才什么都不画（宿主内置渲染器在同样输入下也会崩，
 * 抛错只会多一条红色日志并让宿主把这一格拉黑）；其余情况一律画出可用界面。
 *
 * @param {object} props - 宿主与 inject 提供的 props
 * @returns {object|null} React 元素
 */
function UserMessageView(props) {
  const safe = props === null || props === undefined ? {} : props;
  const node = safe.node;
  const data = node === null || node === undefined ? undefined : node.data;

  // 下面几个 hook 必须无条件调用：hook 顺序不能随消息内容变化
  const busy = useSessionRunning(safe.useSession);
  const day = useCalendarDay();
  const i18n = safe.i18n;
  React.useSyncExternalStore(i18n.subscribe, i18n.language, i18n.language);

  const [ui, setUi] = React.useState({ revealed: false, hover: '', copied: false, sending: false, note: '' });
  /** 同一帧内的即时锁：state 还没刷新时，双击不能把同一条消息发两次 / 复制两次。 */
  const retryLock = React.useRef(false);
  const copyLock = React.useRef(false);
  const copyTimer = React.useRef(null);
  const alive = React.useRef(true);

  React.useEffect(() => {
    alive.current = true;
    retryLock.current = false;
    copyLock.current = false;
    return () => {
      alive.current = false;
      retryLock.current = true;
      copyLock.current = true;
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = null;
    };
  }, []);

  logFirstRender(typeof safe.renderFactorySlot === 'function');

  // 节点数据缺失：没有文本也没有时间，画不出任何东西。
  // 这里刻意不抛错——抛错会让宿主把这一格永久拉黑（abdicate 按条目身份记账），
  // 一条坏数据连累的是整场对话里所有用户消息。
  if (data === null || typeof data !== 'object') return null;

  const update = (patch) => {
    if (alive.current) setUi((previous) => ({ ...previous, ...patch }));
  };

  const parts = contentParts(data.content);
  const text = parts.text;

  // 交给宿主气泡工厂的入参：形状照 UserStyleBubble（ui-chat:5394-5421），
  // 且绝不能出现 sessionId / t / renderFactorySlot 这些宿主已提供的 prop 名（renderer 会直接抛装配错）
  const prepared = { text, attachments: parts.attachments, extraBlocks: parts.rest };
  if (data.referenceLabels !== undefined) prepared.referenceLabels = data.referenceLabels;
  const facts = {};
  if (data.referenceLabels !== undefined) facts.sessionLabels = data.referenceLabels;
  if (data.skillNames !== undefined) facts.skillNames = data.skillNames;

  const sessionId = typeof safe.sessionId === 'string' ? safe.sessionId : '';
  const retry = typeof safe.retry === 'function' ? safe.retry : undefined;
  const showRetry = retry !== undefined && sessionId !== '' && text.trim() !== '' && isRetryableUserNode(node);

  // 工厂缺席时宿主只渲染 fallback、不抛错（renderer:1069），所以 fallback 必须给：
  // 降级也要看得见这条消息说了什么。renderFactorySlot 整个缺失时直接自绘。
  const content =
    typeof safe.renderFactorySlot === 'function'
      ? safe.renderFactorySlot(
          'conversation.chat.user.content',
          { content: prepared, loadImage: safe.loadImage, facts, interactive: true },
          { fallback: renderFallbackBubble(text) },
        )
      : renderFallbackBubble(text);

  function onCopy() {
    if (alive.current === false || ui.copied === true || copyLock.current === true) return undefined;
    copyLock.current = true;
    return Promise.resolve(writeClipboardText(text)).then((ok) => {
      if (alive.current === false) return;
      copyLock.current = false;
      if (ok !== true) return;
      update({ copied: true });
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        copyTimer.current = null;
        update({ copied: false });
      }, COPIED_RESET_MS);
    });
  }

  function onRetry() {
    if (alive.current === false || busy === true || retryLock.current === true) return undefined;
    retryLock.current = true;
    update({ sending: true, note: '' });
    return Promise.resolve(retry(sessionId, text))
      .then(
        (result) => {
          const ok = result !== null && typeof result === 'object' && result.ok === true;
          update({ sending: false, note: ok ? '' : result });
        },
        (error) => {
          update({ sending: false, note: { messageKey: 'retry.failure', error } });
        },
      )
      .finally(() => {
        if (alive.current) retryLock.current = false;
      });
  }

  const actionStyle = (hovered) =>
    hovered === true ? { ...ACTION_BUTTON_STYLE, ...ACTION_HOVER_STYLE } : ACTION_BUTTON_STYLE;

  const clock =
    typeof data.time === 'number'
      ? React.createElement('span', { style: TIME_STYLE }, formatMessageClock(data.time, i18n, day))
      : null;

  const copyButton = React.createElement(
    'button',
    {
      type: 'button',
      style: actionStyle(ui.hover === 'copy'),
      'aria-label': i18n.t(ui.copied === true ? 'copy.done' : 'copy.label'),
      title: i18n.t(ui.copied === true ? 'copy.done' : 'copy.title'),
      onClick: onCopy,
      onMouseEnter: () => update({ hover: 'copy' }),
      onMouseLeave: () => update({ hover: '' }),
    },
    ui.copied === true ? CheckIcon() : CopyIcon(),
  );

  // 生成中或这一下正在发：置灰不可点，避免把消息插进正在生成的回合、也避免连点发两次
  const retryLocked = busy === true || ui.sending === true;
  const retryButton =
    showRetry === true
      ? React.createElement(
          'button',
          {
            type: 'button',
            disabled: retryLocked,
            style: retryLocked
              ? { ...ACTION_BUTTON_STYLE, opacity: 0.4, cursor: 'default' }
              : actionStyle(ui.hover === 'retry'),
            'aria-label': i18n.t('retry.label'),
            title: i18n.t(busy === true ? 'retry.busy' : ui.sending === true ? 'retry.sending' : 'retry.title'),
            onClick: onRetry,
            onMouseEnter: () => update({ hover: 'retry' }),
            onMouseLeave: () => update({ hover: '' }),
          },
          RefreshIcon(),
        )
      : null;

  const note =
    ui.note === '' ? null : React.createElement('span', { style: NOTE_STYLE, role: 'status' }, readFailureNote(ui.note, i18n));

  return React.createElement(
    'div',
    {
      style: ROW_STYLE,
      'data-shuru-user-row': '',
      onMouseEnter: () => update({ revealed: true }),
      onMouseLeave: () => update({ revealed: false, hover: '' }),
      onFocus: () => update({ revealed: true }),
      onBlur: () => update({ revealed: false, hover: '' }),
    },
    content,
    React.createElement(
      'div',
      {
        // 常显而不是 hover 才出现：组件判断不了自己是不是最后一条（要读兄弟节点），
        // 而宿主对最后一条是常显的。宁可每条都半透明可见，也不要让用户以为功能没生效。
        style: { ...ACTIONS_STYLE, opacity: ui.revealed === true ? 1 : 0.55 },
        'data-shuru-actions': 'user',
        'data-clock': 'start',
      },
      clock,
      copyButton,
      retryButton,
      note,
    ),
  );
}

/**
 * 从失败结果里取一句能直接显示的话。
 * @param {unknown} value - createRetryAction 的返回值
 * @returns {string}
 */
function readFailureNote(value, i18n) {
  if (value && typeof value === 'object' && typeof value.messageKey === 'string') {
    return value.messageKey === 'retry.failure' ? describeFailure(value.error, i18n) : i18n.t(value.messageKey);
  }
  if (value !== null && typeof value === 'object' && typeof value.message === 'string' && value.message !== '') {
    return value.message;
  }
  return i18n.t('retry.failure');
}


const historyInject = ['slots', 'conversation', 'shortcuts', 'sessions'];

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
function applyInputHistory(ctx, i18n) {
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


const injectMessageRetry = ['slots', 'sessions'];

function applyMessageRetry(ctx, i18n) {
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

const COMPONENT_MODULES = { history: 'dsh-replay/history', retry: 'dsh-replay/retry' };
const COMPONENT_POLL_MS = 1000;

function createComponentController(ctx, components) {
  const fibers = new Map();
  let closed = false;
  let epoch = 0;
  let inFlight;
  let lifecycle = Promise.resolve();
  let warned = false;

  function reconcile(state, generation) {
    const task = lifecycle.then(async () => {
      for (const key of Object.keys(COMPONENT_MODULES)) {
        if (closed || generation !== epoch) return;
        if (state[key]) {
          if (!fibers.has(key)) fibers.set(key, ctx.plugin(components[key]));
        } else {
          const fiber = fibers.get(key);
          if (!fiber) continue;
          await fiber.dispose();
          fibers.delete(key);
        }
      }
    });
    lifecycle = task.catch(() => {});
    return task;
  }

  function refresh() {
    if (closed) return Promise.resolve();
    if (inFlight) return inFlight;
    const generation = epoch;
    const request = (async () => {
      try {
        const result = await ctx.remote.pluginInventory.list();
        if (closed || generation !== epoch) return;
        if (result?.ok !== true || !Array.isArray(result.value?.entries)) throw new Error('Native component inventory is unavailable');
        const state = {};
        for (const [key, moduleName] of Object.entries(COMPONENT_MODULES)) {
          const rows = result.value.entries.filter((entry) => entry?.moduleName === moduleName);
          if (rows.length !== 1 || typeof rows[0].enabled !== 'boolean') throw new Error('Native component entry is missing or ambiguous: ' + moduleName);
          state[key] = rows[0].enabled;
        }
        await reconcile(state, generation);
        warned = false;
      } catch (error) {
        if (closed || generation !== epoch) return;
        if (!warned) {
          warned = true;
          console.warn('[dsh-replay] Native component synchronization failed; keeping the last verified state.', error);
        }
      }
    })();
    inFlight = request;
    void request.then(() => { if (inFlight === request) inFlight = undefined; });
    return request;
  }

  return {
    refresh,
    reset() {
      if (closed) return Promise.resolve();
      epoch += 1;
      inFlight = undefined;
      return reconcile({ history: false, retry: false }, epoch).then(refresh);
    },
    async dispose() {
      if (closed) return lifecycle;
      closed = true;
      epoch += 1;
      const task = lifecycle.then(async () => {
        const errors = [];
        for (const fiber of fibers.values()) {
          try { await fiber.dispose(); } catch (error) { errors.push(error); }
        }
        fibers.clear();
        if (errors.length) throw new AggregateError(errors, 'Component disposal failed');
      });
      lifecycle = task.catch(() => {});
      return task;
    },
  };
}


const inject = ['slots', 'conversation', 'shortcuts', 'sessions', 'locale', 'remote.pluginInventory'];

function apply(ctx) {
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

return {isFirstLine,isRecallTrigger,createHistory,classifyInput,decideAction,createComposers,extractPromptText,isUserPromptEvent,userPromptIdOf,userPromptTextOf,LOCALES,translateReplay,createReplayI18n,writeClipboardText,isRetryableUserNode,createRetryAction,formatMessageClock,UserMessageView,historyInject,applyInputHistory,injectMessageRetry,applyMessageRetry,COMPONENT_POLL_MS,createComponentController,inject,apply};
}});
