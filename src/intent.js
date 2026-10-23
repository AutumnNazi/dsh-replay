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
export function classifyInput(input) {
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
export function decideAction(direction, state) {
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
