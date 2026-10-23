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
import * as React from 'react';
import { writeClipboardText } from './clipboard.js';
import { isUserPromptEvent } from './prompt.js';
export { extractPromptText, isUserPromptEvent, userPromptIdOf, userPromptTextOf } from './prompt.js';

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
export function isRetryableUserNode(node) {
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
export function createRetryAction(sessions, i18n, isActive = () => true) {
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
export function formatMessageClock(time, i18n, now = Date.now()) {
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
export function UserMessageView(props) {
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
