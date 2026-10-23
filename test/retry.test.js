import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createReplayI18n, translateReplay } from '../src/locale.js';

const i18n = { t: (key, params) => translateReplay(key, 'zh-CN', params), language: () => 'zh-CN', subscribe: () => () => {} };
const englishI18n = { t: (key, params) => translateReplay(key, 'en-US', params), language: () => 'en-US', subscribe: () => () => {} };

/**
 * 用户消息操作行（时间戳 + 复制 + 重试）的行为。
 *
 * 整合前用真实源模块 VM loader + 假 React/假宿主：组件从宿主拿到的 props 形状
 * （node / renderFactorySlot / loadImage / useSession，以及 inject 注入的 retry、i18n）
 * 一律照宿主实际传入的样子造，避免测试比宿主宽松。
 */

/**
 * 假 React：createElement 造普通对象，useState 用「按调用序号」的持久槽，
 * 这样测试能自己控制重渲染，并分别观察「默认态」与「点完之后的态」。
 */
function createReactShim() {
  const slots = [];
  let cursor = 0;
  let stateWrites = 0;
  const effects = [];
  return {
    api: {
      createElement(type, props, ...children) {
        return { type, props: props ?? {}, children: children.flat() };
      },
      useState(initial) {
        const at = cursor++;
        if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
        return [
          slots[at],
          (next) => {
            stateWrites += 1;
            slots[at] = typeof next === 'function' ? next(slots[at]) : next;
          },
        ];
      },
      useRef(initial) {
        const at = cursor++;
        if (!(at in slots)) slots[at] = { current: initial };
        return slots[at];
      },
      useMemo(factory) {
        return factory();
      },
      useCallback(fn) {
        return fn;
      },
      useSyncExternalStore(subscribe, snapshot) {
        this.useEffect(() => subscribe(() => {}), [subscribe]);
        return snapshot();
      },
      useEffect(setup, deps) {
        const at = cursor++;
        const previous = slots[at];
        if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return;
        slots[at] = { deps, cleanup: previous?.cleanup };
        effects.push(() => {
          slots[at].cleanup?.();
          slots[at].cleanup = setup();
        });
      },
    },
    /** 每次渲染前复位 hook 序号：模拟 React 每次 render 从头走一遍 hook 序列。 */
    render(component, props) {
      cursor = 0;
      const tree = component(props);
      for (const effect of effects.splice(0)) effect();
      return tree;
    },
    /** 清空 hook 槽：让每个用例从干净的组件状态开始，用例之间不共享状态。 */
    get stateWrites() { return stateWrites; },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
    reset() {
      this.unmount();
      stateWrites = 0;
      slots.length = 0;
      cursor = 0;
    },
  };
}

/**
 * 假定时器：只登记不执行，测试自己决定什么时候「时间流逝」。
 * 复制按钮 1 秒复位、时间戳跨午夜刷新都挂在这上面。
 */
function createTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout(fn, ms) {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    get pending() { return [...pending.values()]; },
    /** 立刻执行所有登记的回调（模拟时间到）。 */
    flush() {
      const jobs = [...pending.values()];
      pending.clear();
      for (const job of jobs) job.fn();
    },
  };
}

/** 独立加载消息重试源模块，不依赖尚在整合的 package root / bundle；只注入 React。 */
async function loadApi(react, extras = {}) {
  const files = ['src/prompt.js', 'src/clipboard.js', 'src/retry.js', 'src/retry-client.js'];
  const sources = await Promise.all(files.map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')));
  const names = sources.flatMap(source => [...source.matchAll(/^export\s+(?:const|function)\s+(\w+)/gm)].map(match => match[1]));
  const body = sources.map(source => source
    .replace(/^import[^;]*;\r?\n/gm, '')
    .replace(/^export\s+\{[^}]*\}[^;]*;\r?\n/gm, '')
    .replace(/^export\s+(?=(?:const|function)\s)/gm, '')).join('\n');
  const code = `window.__ModuleLoader__.load({ factory: (require) => { const React = require('react'); ${body} return {${names.join(',')}}; } });`;
  let registration;
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    // 默认静音：自检日志每个实例只打一次，别把测试输出刷满
    console: extras.console ?? { info() {}, warn() {}, error() {}, log() {} },
    setTimeout: extras.timers === undefined ? () => 0 : extras.timers.setTimeout,
    clearTimeout: extras.timers === undefined ? () => {} : extras.timers.clearTimeout,
    Map,
    Set,
    WeakMap,
    Object,
    Array,
    String,
    Number,
    JSON,
  };
  if (extras.navigator !== undefined) sandbox.navigator = extras.navigator;
  vm.runInNewContext(code, sandbox);
  return registration.factory((name) => {
    if (name === 'react') return react;
    throw new Error('未授权的外部模块：' + name);
  });
}

const shim = createReactShim();
const api = await loadApi(shim.api);

/**
 * 造一条用户消息在 chat 视图里的样子。
 * 形状照宿主 chatNode（ui-chat:7685-7697）：kind 是 'user'/'steering'，data 是 definition 的 state。
 */
function userNode(overrides = {}) {
  const data = {
    kind: 'user',
    seq: 7,
    time: new Date(2024, 4, 6, 9, 5).getTime(),
    content: [{ type: 'text', text: '你好呀' }],
    source: { kind: 'user' },
    ...overrides,
  };
  return {
    key: '13:input-messagem1',
    kind: data.kind,
    id: 'm1',
    target: 'chat',
    anchorSeq: data.seq,
    visibility: 'visible',
    data,
  };
}

/** 按宿主真实调用形状渲染一次用户消息格。 */
function renderView(props = {}, instance = api) {
  return shim.render(instance.UserMessageView, {
    i18n,
    sessionId: 's1',
    useSession: () => false,
    retry: async () => ({ ok: true }),
    node: userNode(),
    ...props,
  });
}

function collect(tree, predicate, out = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) {
    for (const child of tree) collect(child, predicate, out);
    return out;
  }
  if (predicate(tree)) out.push(tree);
  const own = tree.props && tree.props.children !== undefined ? [tree.props.children] : [];
  for (const child of [...own, ...(tree.children ?? [])]) collect(child, predicate, out);
  return out;
}

function buttonsOf(tree) {
  return collect(tree, (node) => node.type === 'button');
}

function buttonByLabel(tree, label) {
  return buttonsOf(tree).find((button) => button.props['aria-label'] === label);
}

function actionsRowOf(tree) {
  return collect(tree, (node) => node.props !== undefined && node.props['data-shuru-actions'] === 'user')[0];
}

function textOf(tree) {
  if (tree === null || tree === undefined || tree === false || tree === true) return '';
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (typeof tree === 'object') {
    const own = tree.props && tree.props.children !== undefined ? [tree.props.children] : [];
    return [...own, ...(tree.children ?? [])].map(textOf).join('');
  }
  return '';
}

// ── 事件口径：谁算「用户自己发的一句话」 ────────────────────────────────────
// 渲染器拿到的是 chat 视图节点，不是原始事件，但判定必须与输入历史回填同一份口径。

test('旧会话事件（没有 surfaceOp / source / data.id）仍算用户消息：否则旧对话里永远没有重试图标', () => {
  assert.equal(api.isUserPromptEvent({ type: 'user/message', seq: 9, data: { content: '旧事件' } }), true);
  const legacy = { type: 'user/message', seq: 42, data: { content: [{ type: 'text', text: '旧' }] } };
  assert.equal(api.userPromptIdOf(legacy), 'seq-42', '没有 data.id 时用 seq 兜底出稳定身份');
  assert.equal(api.userPromptIdOf(legacy), api.userPromptIdOf(legacy), '同一事件两次必须得到同一个 id');
});

test('AI 回复、被替换的副本、工具注入的上下文都不算用户消息', () => {
  assert.equal(api.isUserPromptEvent({ type: 'assistant/message', data: { id: 'a1' } }), false);
  assert.equal(api.isUserPromptEvent({ type: 'user/message', surfaceOp: 'replace', data: { id: 'm1' } }), false);
  assert.equal(api.isUserPromptEvent({ type: 'user/message', data: { source: { kind: 'tool-registry' } } }), false);
  assert.equal(api.isUserPromptEvent({ type: 'user/message', data: { source: { kind: 'runtime-context' } } }), false);
  assert.equal(api.isUserPromptEvent(null), false);
  assert.equal(api.isUserPromptEvent({ type: 'user/message' }), false);
});

test('视图节点口径：只有 kind===\'user\' 且来源是用户的格子才给重试', () => {
  assert.equal(api.isRetryableUserNode(userNode()), true);
  assert.equal(api.isRetryableUserNode(userNode({ source: { kind: 'tool-registry' } })), false, '工具注入不给重试');
  assert.equal(api.isRetryableUserNode(userNode({ kind: 'steering' })), false, 'steering 是打断当前回答的插话，重发语义不清晰');
  assert.equal(api.isRetryableUserNode(undefined), false);
});

// ── 文本提取：重试与输入历史回填共用同一份 ─────────────────────────────────

test('文本提取：多段拼接、引用 chip 原样保留、附件段不参与', () => {
  assert.equal(api.extractPromptText([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }]), '甲乙');
  assert.equal(
    api.extractPromptText([{ type: 'text', text: '看看 @src/a.js 这个文件' }]),
    '看看 @src/a.js 这个文件',
    '引用 chip 在内容里就是内联文本，不能被吃掉',
  );
  assert.equal(
    api.extractPromptText([{ type: 'image', mediaType: 'image/png', data: 'x' }, { type: 'text', text: '图注' }]),
    '图注',
  );
});

test('文本提取的边界：空内容、缺失内容、坏块、旧版字符串都不抛', () => {
  assert.equal(api.extractPromptText([]), '');
  assert.equal(api.extractPromptText(undefined), '');
  assert.equal(api.extractPromptText(null), '');
  assert.equal(api.extractPromptText([{ type: 'text' }, null, { type: 'text', text: '尾巴' }]), '尾巴');
  assert.equal(api.extractPromptText('老版本就是这样存的'), '老版本就是这样存的', '旧事件把内容存成字符串');
});

// ── 气泡：复用宿主工厂，工厂缺席时降级 ────────────────────────────────────

test('有 renderFactorySlot 时调用一次，且一定传 fallback：工厂缺席时不能整格空白', () => {
  shim.reset();
  const calls = [];
  const tree = renderView({
    renderFactorySlot: (...args) => {
      calls.push(args);
      return { type: 'factory-outlet', props: {}, children: [] };
    },
  });
  assert.equal(calls.length, 1, '气泡本体只调一次工厂');
  assert.equal(calls[0][0], 'conversation.chat.user.content');
  const input = calls[0][1];
  assert.equal(input.content.text, '你好呀', '文本要按宿主 contentParts 拆好再交过去');
  assert.equal(input.interactive, true, '不传 interactive，引用与提及在气泡里点不动');
  assert.ok(Array.isArray(input.content.attachments) && Array.isArray(input.content.extraBlocks));
  assert.ok(calls[0][2] !== undefined && calls[0][2].fallback !== undefined, 'fallback 必须传');
  assert.ok(calls[0][2].fallback !== null, 'fallback 不能是 null：那样工厂缺席时还是空白');
  // 入参里出现宿主保留 prop 名会被 renderer 的冲突检查直接抛 SlotAssemblyError
  for (const reserved of ['sessionId', 't', 'renderFactorySlot', 'useFactorySlot', 'useStore', 'actions', 'node']) {
    assert.equal(reserved in input, false, '工厂入参里不得出现宿主保留名：' + reserved);
  }
  const row = collect(tree, (node) => node.props !== undefined && node.props['data-shuru-user-row'] === '')[0];
  // 宿主 userRow 是「气泡在上、操作行在下」（实机确认），重试图标要挨着复制那一行
  assert.equal(row.children[0].type, 'factory-outlet', '气泡本体在上');
  assert.equal(row.children[1].props['data-shuru-actions'], 'user', '操作行在气泡下方，与宿主 userRow 同构');
});

test('没有 renderFactorySlot 时自绘降级：不抛错，文本与操作行都在', () => {
  shim.reset();
  let tree;
  assert.doesNotThrow(() => {
    tree = renderView();
  });
  assert.match(textOf(tree), /你好呀/, '降级也要把这条消息说了什么画出来');
  assert.ok(buttonByLabel(tree, '复制') !== undefined, '降级路径照样要有复制');
  assert.ok(buttonByLabel(tree, '重试这条消息') !== undefined, '降级路径照样要有重试');
});

test('节点数据缺失时组件不崩也不渲染按钮：抛错只会让宿主拉黑这一格', () => {
  shim.reset();
  assert.doesNotThrow(() => renderView({ node: undefined }));
  assert.equal(buttonsOf(renderView({ node: undefined })).length, 0);
  assert.equal(renderView({ node: { kind: 'user', data: null } }), null);
});

// ── 重试图标的出场条件 ────────────────────────────────────────────────────

test('工具注入的消息（source.kind === tool-registry）不出重试图标，复制照常', () => {
  shim.reset();
  const tree = renderView({ node: userNode({ source: { kind: 'tool-registry' } }) });
  assert.equal(buttonByLabel(tree, '重试这条消息'), undefined, '运行时上下文不是用户发的话');
  assert.ok(buttonByLabel(tree, '复制') !== undefined, '复制对任何消息都成立');
});

test('没有可重发的文本时不出重试图标：纯图片消息重发等于二次上传', () => {
  shim.reset();
  const tree = renderView({ node: userNode({ content: [{ type: 'image', attachment: { id: 'a1' } }] }) });
  assert.equal(buttonByLabel(tree, '重试这条消息'), undefined);
  assert.ok(buttonByLabel(tree, '复制') !== undefined);
});

test('不提供 settings props 仍可完整渲染：原生 Entry 负责开关，不再依赖设置 store', () => {
  shim.reset();
  const tree = renderView();
  assert.ok(buttonByLabel(tree, '重试这条消息') !== undefined);
  assert.ok(buttonByLabel(tree, '复制') !== undefined);
  assert.match(textOf(actionsRowOf(tree)), /\d{2}:\d{2}/);
});

test('会话 id 或发送动作缺失时不出重试图标：点了没反应比没有按钮更糟', () => {
  shim.reset();
  assert.equal(buttonByLabel(renderView({ sessionId: undefined }), '重试这条消息'), undefined);
  assert.equal(buttonByLabel(renderView({ retry: undefined }), '重试这条消息'), undefined);
});

// ── 时间戳 ────────────────────────────────────────────────────────────────

test('时间戳：当天只给 HH:mm，今年更早给「月日」，跨年给「年月日」', () => {
  const nine = new Date(2024, 4, 6, 9, 5).getTime();
  const sameDay = new Date(2024, 4, 6, 20, 0).getTime();
  const sameYear = new Date(2024, 4, 7, 20, 0).getTime();
  const nextYear = new Date(2025, 0, 2, 20, 0).getTime();
  assert.equal(api.formatMessageClock(nine, i18n, sameDay), '09:05');
  assert.equal(api.formatMessageClock(nine, i18n, sameYear), '5月6日 09:05');
  assert.equal(api.formatMessageClock(nine, i18n, nextYear), '2024年5月6日 09:05');
  assert.equal(api.formatMessageClock(nine, englishI18n, sameYear), '5/6 09:05', '英文环境照宿主的 {m}/{d}');
  assert.equal(api.formatMessageClock(nine, englishI18n, nextYear), '2024-5-6 09:05', '跨年日期同样跟随 locale 接口');
});

// ── 操作行的显隐与按钮状态 ────────────────────────────────────────────────

test('操作行不额外加空隙，按钮含内边距的外框仍固定为 28px', () => {
  shim.reset();
  const tree = renderView();
  const row = actionsRowOf(tree);
  assert.equal(row.props.style.gap, 0, '按钮内部留白足够，不再叠加 8px 外部间隙');
  for (const label of ['复制', '重试这条消息']) {
    const style = buttonByLabel(tree, label).props.style;
    assert.equal(style.boxSizing, 'border-box', 'padding 必须包含在标称尺寸中，不额外撑宽按钮');
    assert.equal(style.width, 'calc(28px + var(--dsh-content-font-delta, 0px))');
    assert.equal(style.height, 'calc(28px + var(--dsh-content-font-delta, 0px))');
    assert.equal(style.flexShrink, 0, '容器缩窄时仍保持图标按钮尺寸');
    assert.equal(style.minWidth, 0, '不继承宿主普通文字按钮的最小宽度');
    const outer = 28 + (style.boxSizing === 'border-box' ? 0 : 2 * parseFloat(style.padding));
    assert.equal(outer + Number(row.props.style.gap), 28, '无字号增量时，图标中心间距由 36px 收紧到 28px，点击区域不缩小');
  }
  const time = row.children.find(child => child && child.type === 'span' && child.props.style && child.props.style.whiteSpace === 'nowrap');
  assert.equal(time.props.style.paddingRight ?? 0, 0, '时间后不叠加额外 padding');
});

test('时间与复制按钮背景留 8px 外间距，复制重试仍保持紧凑', () => {
  shim.reset();
  const row = actionsRowOf(renderView());
  const time = row.children.find(child => child && child.type === 'span' && child.props.style && child.props.style.whiteSpace === 'nowrap');
  assert.equal(time.props.style.marginInlineEnd, '8px', '间隔在按钮背景外，不靠按钮内边距分隔时间');
  assert.equal(time.props.style.flexShrink, 0, '窄容器内时间不被压进按钮');
  assert.equal(time.props.style.paddingRight ?? 0, 0);
  assert.equal(row.props.style.gap, 0, '不扩大两个图标按钮间距');
  const copy = buttonByLabel(renderView(), '复制');
  copy.props.onMouseEnter();
  const hovered = actionsRowOf(renderView());
  const hoveredTime = hovered.children.find(child => child && child.type === 'span' && child.props.style && child.props.style.whiteSpace === 'nowrap');
  assert.equal(hoveredTime.props.style.marginInlineEnd, '8px');
  assert.equal(hoveredTime.props.style.background, undefined, '悬停背景只属于按钮，时间不跟着着色');
});

test('操作行常显（默认半透明），行容器 hover 之后提亮', () => {
  shim.reset();
  const idle = actionsRowOf(renderView());
  // 组件判断不了自己是不是最后一条（要读兄弟节点），而宿主对最后一条是常显的；
  // 如果这里默认 0，用户会以为重试功能没生效——宁可每条半透明可见。
  assert.equal(idle.props.style.opacity, 0.55, '常显但压低存在感');
  const row = collect(renderView(), (node) => node.props !== undefined && node.props['data-shuru-user-row'] === '')[0];
  row.props.onMouseEnter();
  const hovered = actionsRowOf(renderView());
  assert.equal(hovered.props.style.opacity, 1, 'hover 之后必须提亮');
});

test('turn 进行中重试按钮置灰不可点，避免把消息插进正在生成的回合', () => {
  shim.reset();
  const idle = buttonByLabel(renderView(), '重试这条消息');
  assert.notEqual(idle.props.disabled, true, '没有进行中的 turn 时应当可点');
  const busy = buttonByLabel(renderView({ useSession: (selector) => selector({ running: true }) }), '重试这条消息');
  assert.equal(busy.props.disabled, true);
  assert.match(String(busy.props.title ?? ''), /正在/);
});

test('点重试把这条消息的文本交给注入的发送函数', async () => {
  shim.reset();
  const calls = [];
  const tree = renderView({
    retry: async (sessionId, text) => {
      calls.push([sessionId, text]);
      return { ok: true };
    },
  });
  await buttonByLabel(tree, '重试这条消息').props.onClick();
  assert.deepEqual(calls, [['s1', '你好呀']]);
});

test('连点两次只发一次：同一帧内 state 还没刷新，靠即时锁挡住', async () => {
  shim.reset();
  let calls = 0;
  const retry = async () => {
    calls += 1;
    return { ok: true };
  };
  const button = buttonByLabel(renderView({ retry }), '重试这条消息');
  const first = button.props.onClick();
  const second = button.props.onClick();
  await Promise.all([first, second]);
  assert.equal(calls, 1, '双击不能把同一条消息发两次');
});

test('重发失败时操作行出现可见提示，而不是静默', async () => {
  shim.reset();
  const retry = async () => ({ ok: false, message: '额度不足，稍后再试' });
  await buttonByLabel(renderView({ retry }), '重试这条消息').props.onClick();
  assert.match(textOf(renderView({ retry })), /额度不足/);
});

test('重发成功后不留下失败提示', async () => {
  shim.reset();
  const retry = async () => ({ ok: true });
  await buttonByLabel(renderView({ retry }), '重试这条消息').props.onClick();
  assert.equal(textOf(renderView({ retry })).includes('失败'), false);
});

// ── 复制 ──────────────────────────────────────────────────────────────────

test('点复制把文本交给剪贴板，成功后切成「已复制」，1 秒后复位', async () => {
  const written = [];
  const timers = createTimers();
  const instance = await loadApi(shim.api, {
    timers,
    navigator: { clipboard: { writeText: async (text) => { written.push(text); } } },
  });
  shim.reset();
  const props = { i18n, sessionId: 's1', useSession: () => false, retry: async () => ({ ok: true }), node: userNode() };
  assert.ok(buttonByLabel(shim.render(instance.UserMessageView, props), '复制') !== undefined, '默认是复制图标');
  await buttonByLabel(shim.render(instance.UserMessageView, props), '复制').props.onClick();
  assert.deepEqual(written, ['你好呀']);
  assert.ok(buttonByLabel(shim.render(instance.UserMessageView, props), '已复制') !== undefined, '复制成功要看得见反馈');
  timers.flush();
  assert.ok(buttonByLabel(shim.render(instance.UserMessageView, props), '复制') !== undefined, '1 秒后复位');
});

test('剪贴板写失败时不能假装已复制：图标必须留在「复制」', async () => {
  const instance = await loadApi(shim.api, {
    timers: createTimers(),
    navigator: {
      clipboard: {
        writeText: async () => {
          throw new Error('权限被拒');
        },
      },
    },
  });
  shim.reset();
  const props = { i18n, sessionId: 's1', useSession: () => false, retry: async () => ({ ok: true }), node: userNode() };
  await buttonByLabel(shim.render(instance.UserMessageView, props), '复制').props.onClick();
  assert.ok(buttonByLabel(shim.render(instance.UserMessageView, props), '复制') !== undefined);
});

test('复制 Promise 卸载后才完成：不写旧 state，也不新排 1 秒 timer', async () => {
  let resolve;
  const timers = createTimers();
  const instance = await loadApi(shim.api, {
    timers,
    navigator: { clipboard: { writeText: () => new Promise(done => { resolve = done; }) } },
  });
  shim.reset();
  const promise = buttonByLabel(renderView({}, instance), '复制').props.onClick();
  shim.unmount();
  const writes = shim.stateWrites;
  resolve();
  await promise;
  assert.equal(shim.stateWrites, writes, '复制反馈不能写已卸载视图');
  assert.equal(timers.pending.length, 0, '午夜 timer 清理，迟到复制不能再排 timer');
});

test('重试 Promise resolve / reject 晚到不写旧视图，卸载旧点击不可再次发送', async () => {
  for (const fails of [false, true]) {
    shim.reset();
    let resolve;
    let reject;
    let calls = 0;
    const retry = () => {
      calls += 1;
      return new Promise((done, failed) => { resolve = done; reject = failed; });
    };
    const button = buttonByLabel(renderView({ retry }), '重试这条消息');
    const promise = button.props.onClick();
    shim.unmount();
    const writes = shim.stateWrites;
    if (fails) reject(new Error('迟到错误')); else resolve({ ok: true });
    await promise;
    assert.equal(shim.stateWrites, writes, '迟到发送结果不能写旧 state');
    assert.equal(button.props.onClick(), undefined, '旧 onClick 不能重新发起 prompt');
    assert.equal(calls, 1);
  }
});

test('英文 DSH locale 控制按钮、提示和错误前缀，宿主错误本体不翻译', async () => {
  shim.reset();
  const tree = renderView({ i18n: englishI18n });
  assert.equal(buttonsOf(tree)[0].props['aria-label'], 'Copy');
  assert.equal(buttonsOf(tree)[0].props.title, 'Copy this message');
  assert.equal(buttonsOf(tree)[1].props['aria-label'], 'Retry this message');
  const result = await api.createRetryAction({ binding: () => ({ session: {
    prompt: async () => ({ ok: false, error: { message: '宿主原始错误' } }),
  } }) }, englishI18n).send('s1', '消息');
  assert.match(result.message, /^Resend failed/);
  assert.match(result.message, /宿主原始错误/);
});

test('复制成功已排的 timer 与午夜 timer 卸载时一起清理，旧 copy 点击不再写剪贴板', async () => {
  const timers = createTimers();
  let copies = 0;
  const instance = await loadApi(shim.api, {
    timers, navigator: { clipboard: { writeText: async () => { copies += 1; } } },
  });
  shim.reset();
  const button = buttonByLabel(renderView({}, instance), '复制');
  await button.props.onClick();
  assert.ok(timers.pending.some(timer => timer.ms === 1000));
  shim.unmount();
  const writes = shim.stateWrites;
  assert.equal(timers.pending.length, 0);
  timers.flush();
  assert.equal(shim.stateWrites, writes);
  assert.equal(button.props.onClick(), undefined);
  assert.equal(copies, 1);
});

test('DSH 运行时语言切换刷新按钮、日期、失败前缀，并在卸载时释放语言订阅', async () => {
  shim.reset();
  let active = 'zh-CN';
  const listeners = new Set();
  const locale = {
    getSnapshot: () => ({ active }),
    resolveText: dict => active === 'zh-CN' ? dict.zh : dict.en,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const liveI18n = createReplayI18n(locale);
  const action = api.createRetryAction({ binding: () => ({ session: {
    prompt: async () => ({ ok: false, error: { message: 'HOST_ERROR' } }),
  } }) }, liveI18n);
  const props = { i18n: liveI18n, retry: (id, text) => action.send(id, text) };
  await buttonByLabel(renderView(props), '重试这条消息').props.onClick();
  assert.match(textOf(renderView(props)), /重发失败/);
  assert.equal(listeners.size, 1);
  active = 'en-US';
  for (const listener of listeners) listener();
  const english = renderView(props);
  assert.ok(buttonByLabel(english, 'Retry this message'));
  assert.match(textOf(actionsRowOf(english)), /2024-5-6 09:05/);
  assert.match(textOf(english), /Resend failed/);
  assert.match(textOf(english), /HOST_ERROR/);
  shim.unmount();
  assert.equal(listeners.size, 0);
  let remaining = 0;
  const stop = liveI18n.subscribe(() => { remaining += 1; });
  assert.equal(listeners.size, 1, 'child 不得 dispose root 共享 i18n');
  stop();
  liveI18n.dispose();
});

// ── 自检日志 ──────────────────────────────────────────────────────────────

test('自检日志只在首次渲染打一次，并如实报告工厂入口在不在', async () => {
  const seen = [];
  const instance = await loadApi(shim.api, {
    console: { info: (...args) => seen.push(args), warn() {}, error() {}, log() {} },
  });
  shim.reset();
  const props = { i18n, sessionId: 's1', useSession: () => false, retry: async () => ({ ok: true }), node: userNode() };
  shim.render(instance.UserMessageView, props);
  shim.render(instance.UserMessageView, props);
  shim.render(instance.UserMessageView, props);
  assert.equal(seen.length, 1, '每次渲染都刷屏会把控制台淹掉');
  assert.equal(seen[0][0], '[shuru] 用户消息操作行已接管');
  assert.equal(seen[0][1].hasFactory, false, '没有工厂入口时必须如实报告 false');

  const withFactory = [];
  const second = await loadApi(shim.api, {
    console: { info: (...args) => withFactory.push(args), warn() {}, error() {}, log() {} },
  });
  shim.reset();
  shim.render(second.UserMessageView, { ...props, renderFactorySlot: () => null });
  assert.equal(withFactory.length, 1);
  assert.equal(withFactory[0][1].hasFactory, true);
});

// ── 发送动作 ───────────────────────────────────────────────────────────────

test('重发：mode 必须是 queue，且绝不传 requestId', async () => {
  const calls = [];
  const sessions = {
    binding: () => ({
      session: {
        prompt: async (...args) => {
          calls.push(args);
          return { ok: true, value: { accepted: true } };
        },
      },
    }),
  };
  const action = api.createRetryAction(sessions, i18n);
  const result = await action.send('s1', '你好呀');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].length, 1, '只发一个文本段');
  assert.equal(calls[0][0][0].type, 'text');
  assert.equal(calls[0][0][0].text, '你好呀');
  assert.equal(calls[0][1], 'queue', 'steer 会被 next-step 认领成 steering 行，语义就变了');
  assert.equal(calls[0][3], undefined, 'requestId 必须留空让宿主现造，复用旧 id 会被幂等查重吞掉');
});

test('重发失败要把原因交回界面：prompt 返回 ok:false 时不得静默', async () => {
  const sessions = {
    binding: () => ({ session: { prompt: async () => ({ ok: false, error: { code: 'QUOTA', message: '额度不足' } }) } }),
  };
  const result = await api.createRetryAction(sessions, i18n).send('s1', '你好呀');
  assert.equal(result.ok, false);
  assert.match(result.message, /额度不足/);
});

test('重发失败要把原因交回界面：prompt 抛异常时不得外抛', async () => {
  const sessions = {
    binding: () => ({ session: { prompt: async () => { throw new Error('网络断了'); } } }),
  };
  const result = await api.createRetryAction(sessions, i18n).send('s1', '你好呀');
  assert.equal(result.ok, false);
  assert.match(result.message, /网络断了/);
});

test('会话不可用或文本为空时不发请求，并给出可读原因', async () => {
  let called = 0;
  const sessions = { binding: () => undefined, session: { prompt: async () => { called += 1; } } };
  const action = api.createRetryAction(sessions, i18n);
  const missing = await action.send('s1', '你好呀');
  assert.equal(missing.ok, false);
  assert.equal(called, 0);
  const blank = await action.send('s1', '   ');
  assert.equal(blank.ok, false);
  assert.equal(called, 0);
  assert.match(blank.message, /文本/);
});

// ── 插件接线 ───────────────────────────────────────────────────────────────

function createCtx() {
  const slots = [];
  const promptCalls = [];
  const ctx = {
    conversation: { input: { shell: () => null } },
    shortcuts: { observeFixedInput: () => () => {}, registerFixed: () => () => {} },
    slots: {
      inject: (_name, fn) => fn(),
      register(meta, Component) {
        slots.push({ meta, Component });
        return () => {};
      },
    },
    sessions: {
      binding: () => ({
        session: {
          prompt: async (...args) => {
            promptCalls.push(args);
            return { ok: true, value: { accepted: true } };
          },
        },
      }),
    },
    effect(fn) {
      return fn();
    },
  };
  return { ctx, slots, promptCalls };
}

test('接线：遮蔽 conversation.chat.node 的 user 格，priority 必须比内置（0）更低', () => {
  const host = createCtx();
  api.applyMessageRetry(host.ctx, i18n);
  const entries = host.slots.filter((entry) => entry.meta.name === 'conversation.chat.node');
  assert.equal(entries.length, 1, '只接管 user 一格，steering 不碰');
  assert.equal(entries[0].meta.key, 'user', '重试图标要落在复制所在的那一行');
  assert.equal(entries[0].meta.priority, -1, 'keyed 槽按 priority 升序取第一个存活条目，内置是 0');
  assert.equal(entries[0].Component, api.UserMessageView);
  const injected = entries[0].meta.inject('s1');
  assert.equal(injected.sessionId, 's1', '渲染组件靠 inject 拿到 sessionId');
  assert.equal(typeof injected.retry, 'function', '发送动作也走 inject，组件不认识宿主服务');
  assert.equal('settings' in injected, false, '原生组件不再注入自建设置');
});

test('宿主没有 uiConversation 也照常接管：那个服务不再是依赖', () => {
  const host = createCtx();
  assert.equal(host.ctx.uiConversation, undefined);
  assert.doesNotThrow(() => api.applyMessageRetry(host.ctx, i18n));
  assert.equal(host.slots.filter((entry) => entry.meta.name === 'conversation.chat.node').length, 1);
  assert.equal(Array.from(api.injectMessageRetry).includes('uiConversation'), false, 'inject 里不能留死依赖');
});

test('端到端：点重试真的把消息追加发送出去（mode=queue，不传 requestId）', async () => {
  const host = createCtx();
  api.applyMessageRetry(host.ctx, i18n);
  const entry = host.slots.find((item) => item.meta.name === 'conversation.chat.node');
  shim.reset();
  const tree = shim.render(entry.Component, { useSession: () => false, ...entry.meta.inject('s1'), node: userNode() });
  const button = buttonByLabel(tree, '重试这条消息');
  assert.ok(button !== undefined, '操作行里必须有重试图标');
  await button.props.onClick();
  assert.equal(host.promptCalls.length, 1);
  assert.equal(host.promptCalls[0][0].length, 1);
  assert.equal(host.promptCalls[0][0][0].type, 'text');
  assert.equal(host.promptCalls[0][0][0].text, '你好呀');
  assert.equal(host.promptCalls[0][1], 'queue');
  assert.equal(host.promptCalls[0][3], undefined);
});
