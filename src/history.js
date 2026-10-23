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
export function isFirstLine(text, caret) {
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
export function isRecallTrigger(text, caret) {
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
export function createHistory(options = {}) {
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
