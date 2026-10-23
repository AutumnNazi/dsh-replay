import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildClientBundle } from '../scripts/bundle.mjs';

/**
 * 假 React：useEffect 在 render 期间只登记，commit 阶段才执行。
 * 这样测试能分别观察「只渲染」与「渲染后提交」两种状态，
 * 把「槽位组件不得在 render 里做副作用」变成可执行断言。
 */
function createReactShim() {
  let collecting = null;
  return {
    api: {
      useEffect(effect) {
        if (collecting !== null) collecting.push(effect);
      },
    },
    begin() {
      collecting = [];
      return collecting;
    },
    end() {
      collecting = null;
    },
  };
}

/** 加载真实的构建产物（与 build.mjs 同一份拼接逻辑），只注入 react。 */
async function loadPlugin(react) {
  const { code } = await buildClientBundle();
  let registration;
  vm.runInNewContext(code, {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    console,
    Map,
    Set,
    WeakMap,
    Object,
    Array,
    String,
    Number,
    JSON,
    setTimeout,
    clearTimeout,
  });
  assert.equal(registration.id, '@bxzy/dsh-replay');
  return registration.factory((name) => {
    if (name === 'react') return react;
    throw new Error('未授权的外部模块：' + name);
  });
}

/**
 * 造一个假宿主：只实现本插件真正用到的那几个服务面。
 * 目的是把「绝不 consume」「多会话不串」「卸载后不留监听」「render 不产生副作用」这些约束
 * 变成可执行断言，而不是只写在注释里。
 */
async function loadApi() {
  const shim = createReactShim();
  return { shim, api: await loadPlugin(shim.api) };
}

/**
 * @param {{shim: object, api: object}} [shared] - 复用同一个模块实例（真实宿主里 bundle 只加载一次）
 * @param {{sessions?: object}} [options] - 只有显式给了 sessions 才挂上，缺省保持「没有会话记录服务」的降级路径可测
 */
async function createHost(shared, options = {}) {
  const { shim, api } = shared ?? (await loadApi());

  const listeners = new Set();
  const fixedRows = [];
  const registrations = [];
  const effects = [];
  const consumed = [];
  const shells = new Map();
  const cleanupsBySession = new Map();

  /** 造一个会话的输入外壳；写入草稿会像宿主一样同步通知订阅者。 */
  function shellFor(sessionId) {
    const existing = shells.get(sessionId);
    if (existing !== undefined) return existing;
    const root = {
      sessionId,
      contains: (target) => target !== null && typeof target === 'object' && target.__session === sessionId,
    };
    const state = { text: '', references: [], caret: 0, writes: [], subs: new Set() };
    const notify = () => {
      for (const fn of [...state.subs]) fn();
    };
    const shell = {
      editor: { getRootElement: () => root },
      get projection() {
        return { clipboardText: state.text, detectText: state.text, caret: state.caret, occurrences: state.references };
      },
      actions: {
        setDraft(value) {
          const next = typeof value === 'string' ? value : value.text;
          state.writes.push(value);
          state.text = next;
          state.caret = state.text.length;
          notify();
        },
      },
      state: {
        getSnapshot: () => ({ draft: state.text }),
        subscribe: (fn) => {
          state.subs.add(fn);
          return () => state.subs.delete(fn);
        },
      },
    };
    const record = { shell, state, notify, root };
    shells.set(sessionId, record);
    return record;
  }

  const conversation = { input: { shell: (sessionId) => shellFor(sessionId).shell } };

  const ctx = {
    conversation,
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return dispose;
    },
    shortcuts: {
      observeFixedInput(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      registerFixed(row) {
        fixedRows.push(row);
        return () => {
          const at = fixedRows.indexOf(row);
          if (at >= 0) fixedRows.splice(at, 1);
        };
      },
    },
    slots: {
      inject(_name, fn) {
        return fn();
      },
      register(meta, Component) {
        const entry = { meta, Component };
        registrations.push(entry);
        return () => {
          const index = registrations.indexOf(entry);
          if (index >= 0) registrations.splice(index, 1);
        };
      },
    },
  };

  return {
    api,
    apply() {
      api.applyInputHistory(ctx, api.createReplayI18n());
    },
    listeners,
    fixedRows,
    registrations,
    consumed,
    shellFor,
    /** 只渲染，不跑 effect —— 对应 React 的 render 阶段。 */
    render(sessionId) {
      // 按 name 找锚点，不靠注册顺序：插件还会注册设置区等其它槽位，顺序不该成为契约
      const entry = registrations.find((item) => item.meta.name === 'conversation.composer.dock');
      assert.ok(entry !== undefined, '插件没有注册 composer.dock 锚点');
      const props = entry.meta.inject(sessionId);
      const bucket = shim.begin();
      const out = entry.Component(props);
      shim.end();
      assert.equal(out, null, '锚点组件不得渲染任何 DOM');
      return bucket;
    },
    /** 渲染后跑 effect —— 对应 React 的 commit 阶段。 */
    commit(sessionId) {
      const cleanups = this.render(sessionId).map((effect) => effect());
      cleanupsBySession.set(sessionId, cleanups);
    },
    /** 渲染 + 提交，等同于宿主把这个会话的 composer.dock 挂上去。 */
    mount(sessionId) {
      this.commit(sessionId);
    },
    /** 组件卸载：跑 effect 的 cleanup。 */
    unmountComposer(sessionId) {
      for (const cleanup of cleanupsBySession.get(sessionId) ?? []) {
        if (typeof cleanup === 'function') cleanup();
      }
      cleanupsBySession.delete(sessionId);
    },
    /** 把草稿改成指定文本并像宿主一样广播一次（模拟用户打字）。 */
    type(sessionId, text) {
      const record = shellFor(sessionId);
      record.state.text = text;
      record.state.caret = text.length;
      record.notify();
    },
    /** 模拟宿主在发送后清空草稿。 */
    clear(sessionId) {
      const record = shellFor(sessionId);
      record.state.text = '';
      record.state.caret = 0;
      record.notify();
    },
    /** 投递一次 fixed-input 观察结果。 */
    press(code, sessionId, overrides = {}) {
      const target = shellFor(sessionId).root;
      let eventConsumed = false;
      const input = {
        type: 'keydown',
        gesture: {
          code,
          control: false,
          alt: false,
          shift: false,
          meta: false,
          repeat: false,
          composing: false,
          defaultPrevented: false,
          ...(overrides.gesture ?? {}),
        },
        context: { region: 'editable', modal: null, target, ...(overrides.context ?? {}) },
        consume() {
          eventConsumed = true;
          consumed.push(code);
        },
      };
      for (const listener of [...listeners]) listener(input);
      if (!eventConsumed && typeof overrides.browserDefaultAction === 'function') {
        overrides.browserDefaultAction(shellFor(sessionId).state);
      }
    },
    writesOf(sessionId) {
      return shellFor(sessionId).state.writes;
    },
    subscriptionsOf(sessionId) {
      return shellFor(sessionId).state.subs.size;
    },
    /** 插件级卸载：跑所有 ctx.effect 的收尾。 */
    dispose() {
      for (const dispose of effects.reverse()) {
        if (typeof dispose === 'function') dispose();
      }
    },
  };
}

/** 先发一条消息把历史喂进去：打字 → 回车 → 宿主清空。 */
function send(host, sessionId, text) {
  host.type(sessionId, text);
  host.press('Enter', sessionId);
  host.clear(sessionId);
}

test('装配契约：观察固定输入、声明 ↑/↓ 清单、注册 composer.dock 锚点', async () => {
  const host = await createHost();
  host.apply();
  assert.equal(host.listeners.size, 1, '必须且只注册一个固定输入观察者');
  assert.deepEqual(host.fixedRows.map((row) => row.id).sort(), ['dsh-replay.history.next', 'dsh-replay.history.prev']);
  // 原生停用会移除锚点，不再注入自建设置区。
  assert.deepEqual(
    host.registrations.map((entry) => entry.meta.name).sort(),
    ['conversation.composer.dock'],
  );
  const dock = host.registrations.find((entry) => entry.meta.name === 'conversation.composer.dock');
  assert.equal(dock.meta.id, 'dsh-replay.history');
  host.dispose();
});

test('挂载发生在 commit 阶段：只 render 不 commit 时不会订阅、也不接管按键', async () => {
  const host = await createHost();
  host.apply();
  host.render('s1');
  assert.equal(host.subscriptionsOf('s1'), 0, 'render 阶段不许产生副作用');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), [], '还没提交时按键不得被接管');
  host.commit('s1');
  assert.equal(host.subscriptionsOf('s1'), 1, 'commit 阶段才建立草稿跟踪');
  send(host, 's1', '历史一条');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), ['历史一条']);
  host.dispose();
});

test('重复 commit 不会重复订阅：mount 幂等', async () => {
  const host = await createHost();
  host.apply();
  host.commit('s1');
  host.commit('s1');
  host.commit('s1');
  assert.equal(host.subscriptionsOf('s1'), 1);
  host.dispose();
});

test('宿主 getSnapshot 抛错时不影响挂载与渲染，也不外抛', async () => {
  const host = await createHost();
  host.apply();
  const record = host.shellFor('s1');
  record.shell.state.getSnapshot = () => {
    throw new Error('host store exploded');
  };
  assert.doesNotThrow(() => host.mount('s1'), '宿主 store 抛错绝不能炸掉输入框的渲染');
  assert.doesNotThrow(() => host.type('s1', '随便打点字'));
  assert.doesNotThrow(() => host.press('ArrowUp', 's1'));
  assert.doesNotThrow(() => host.press('Enter', 's1'));
  host.dispose();
});

test('composer 卸载后登记簿同步清理：该会话的 ↑ 不再被接管', async () => {
  const host = await createHost();
  host.apply();
  host.mount('s1');
  send(host, 's1', '历史一条');
  assert.equal(host.subscriptionsOf('s1'), 1);
  host.unmountComposer('s1');
  assert.equal(host.subscriptionsOf('s1'), 0, '卸载后必须收回订阅');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), [], '卸载后该会话不再被接管');
  host.dispose();
});

test('只消费成功接管的历史方向键，其余键保留原生行为', async () => {
  const host = await createHost();
  host.apply();
  host.mount('s1');
  host.press('ArrowUp', 's1');
  host.press('ArrowDown', 's1');
  assert.deepEqual(host.consumed, [], '空历史不接管');
  send(host, 's1', '发过的消息');
  host.press('ArrowUp', 's1');
  host.press('ArrowDown', 's1');
  assert.deepEqual(host.consumed, ['ArrowUp', 'ArrowDown'], '写回历史后不能再让浏览器移动光标');
  host.consumed.length = 0;
  host.type('s1', '第一行\n第二行');
  host.press('ArrowUp', 's1');
  host.press('Enter', 's1');
  host.press('ArrowUp', 's1', { gesture: { defaultPrevented: true } });
  host.press('ArrowUp', 's1', { gesture: { shift: true } });
  host.press('ArrowUp', 's1', { gesture: { composing: true } });
  assert.deepEqual(host.consumed, [], '手动编辑、回车、菜单、修饰键和输入法一律让路');
  host.dispose();
});

test('写回失败时不消费方向键，也不滚动对话', async () => {
  const host = await createHost();
  host.apply();
  host.mount('s1');
  const record = host.shellFor('s1');
  send(host, 's1', '一条历史');
  record.shell.actions.setDraft = () => { throw new Error('write rejected'); };
  record.root.scrollIntoView = () => assert.fail('不得滚动聊天区');
  let nativeMoves = 0;
  host.press('ArrowUp', 's1', { browserDefaultAction() { nativeMoves += 1; } });
  assert.deepEqual(host.consumed, []);
  assert.equal(nativeMoves, 1, '写入失败仍交还原生行为');
  host.dispose();
});

test('空输入框按 ↑ 翻出本会话上一条已发送输入', async () => {
  const host = await createHost();
  host.apply();
  host.mount('s1');
  send(host, 's1', '你好呀');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), ['你好呀']);
  host.dispose();
});

test('非空且光标不在首行时按 ↑ 不写回：原生光标上移照旧', async () => {
  const host = await createHost();
  host.apply();
  host.mount('s1');
  send(host, 's1', '历史一条');
  host.type('s1', '第一行\n第二行');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), [], '光标不在首行时必须让原生行为接管');
  host.dispose();
});

test('非空且光标在首行时按 ↑ 翻历史，↓ 把原草稿原样还回来', async () => {
  const host = await createHost();
  host.apply();
  host.mount('s1');
  send(host, 's1', '历史一条');
  host.shellFor('s1').state.text = '第一行\n第二行';
  host.shellFor('s1').state.caret = 2;
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), ['历史一条']);
  host.press('ArrowDown', 's1');
  assert.deepEqual(host.writesOf('s1'), ['历史一条', '第一行\n第二行']);
  host.dispose();
});

test('多会话不串：两个会话交错翻历史，各自只看到自己的记录', async () => {
  const host = await createHost();
  host.apply();
  host.mount('a');
  host.mount('b');
  send(host, 'a', 'A-消息');
  send(host, 'b', 'B-消息');
  host.press('ArrowUp', 'a');
  assert.deepEqual(host.writesOf('a'), ['A-消息']);
  assert.deepEqual(host.writesOf('b'), [], '按 a 的 ↑ 不能动 b 的输入框');
  host.press('ArrowUp', 'b');
  assert.deepEqual(host.writesOf('b'), ['B-消息']);
  assert.deepEqual(host.writesOf('a'), ['A-消息'], '按 b 的 ↑ 不能把 a 又翻一条');
  host.dispose();
});

test('Lexical 已消费（defaultPrevented）时完全不写回', async () => {
  const host = await createHost();
  host.apply();
  host.mount('s1');
  send(host, 's1', '历史一条');
  host.press('ArrowUp', 's1', { gesture: { defaultPrevented: true } });
  assert.deepEqual(host.writesOf('s1'), []);
  host.dispose();
});

test('回车记一条：Shift+Enter 换行不记，Ctrl+Meta 同时按下不记，Ctrl+Enter / Cmd+Enter 要记', async () => {
  const host = await createHost();
  host.apply();
  host.mount('s1');
  host.type('s1', '要发的消息');
  host.press('Enter', 's1', { gesture: { shift: true } });
  host.clear('s1');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), [], 'Shift+Enter 是换行，不该进历史');

  host.type('s1', '要发的消息');
  host.press('Enter', 's1', { gesture: { control: true, meta: true } });
  host.clear('s1');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), [], 'Ctrl+Meta 同时按下被宿主吞掉，不是发送');

  host.type('s1', '要发的消息');
  host.press('Enter', 's1', { gesture: { control: true } });
  host.clear('s1');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), ['要发的消息'], 'Ctrl+Enter 是宿主的另一种发送模式');
  host.dispose();
});

test('用户手改草稿后自动退出回翻，不再被 ↑ 接管', async () => {
  const host = await createHost();
  host.apply();
  host.mount('s1');
  send(host, 's1', '历史一条');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), ['历史一条']);
  host.type('s1', '历史一条\n我自己接着写');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), ['历史一条'], '用户改过草稿后不能再被当成回翻状态');
  host.dispose();
});

test('长按 ↑ 的 repeat 事件按每条各翻一条', async () => {
  const host = await createHost();
  host.apply();
  host.mount('s1');
  send(host, 's1', '第一条');
  send(host, 's1', '第二条');
  host.press('ArrowUp', 's1');
  host.press('ArrowUp', 's1', { gesture: { repeat: true } });
  assert.deepEqual(host.writesOf('s1'), ['第二条', '第一条']);
  host.dispose();
});

test('卸载后不留监听：ctx.effect 收尾会解注册固定输入观察者', async () => {
  const host = await createHost();
  host.apply();
  host.mount('s1');
  send(host, 's1', '历史一条');
  assert.equal(host.listeners.size, 1);
  host.dispose();
  assert.equal(host.listeners.size, 0, '插件卸载后不许残留监听');
  assert.deepEqual(host.fixedRows, [], '快捷键清单声明也要一起收回');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), [], '卸载后按键不得再触发写回');
});

/** 等一次宏任务：懒加载是后台拉的，按键本身绝不等它。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 造一个会话记录服务：binding 交出的形状与宿主一致（sessionId / session / eventSource）。
 * entries 是会话已加载窗口里的事件条目，外层 type 区分持久事件与 client-only 瞬时事件。
 */
function sessionHistoryService(entriesBySession) {
  const calls = [];
  return {
    calls,
    binding(sessionId) {
      calls.push(sessionId);
      const entries = entriesBySession[sessionId];
      if (entries === undefined) return undefined;
      return {
        sessionId,
        session: { openState: 'open', open: async () => {} },
        eventSource: { getSnapshot: () => ({ entries, hasMore: false, revision: 1, change: { kind: 'replace', entries } }) },
      };
    },
  };
}

/** 造一条持久事件条目。 */
function persisted(event) {
  return { type: 'event', event };
}

test('旧对话：会话一挂载就把记录读进来，第一次按 ↑ 拿到的就是完整栈', async () => {
  const sessions = sessionHistoryService({
    s1: [
      persisted({ type: 'user/message', seq: 1, time: 1, data: { id: 'm1', content: [{ type: 'text', text: '旧对话第一句' }] } }),
      persisted({ type: 'assistant/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'AI 的回复' }] } }),
      // 旧事件：没有 surfaceOp / source / data.id，内容是纯字符串
      persisted({ type: 'user/message', seq: 5, time: 5, data: { content: '旧对话第二句' } }),
      { type: 'transient', event: { type: 'assistant/live-chunk', seq: 6, time: 6, data: {} } },
    ],
  });
  const host = await createHost(undefined, { sessions });
  host.apply();
  host.mount('s1');
  await tick();
  assert.deepEqual(sessions.calls, ['s1'], '挂载即回填，且只拉一次');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), ['旧对话第二句'], '最新的旧消息在栈顶，AI 回复与瞬时事件不算');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), ['旧对话第二句', '旧对话第一句']);
  host.press('ArrowUp', 's1');
  assert.deepEqual(sessions.calls, ['s1'], '按键路径不再重复拉取');
  host.dispose();
});

test('挂载即回填：同一会话重复挂载不再发起第二次', async () => {
  const sessions = sessionHistoryService({
    s1: [persisted({ type: 'user/message', seq: 1, time: 1, data: { content: '旧消息' } })],
  });
  const host = await createHost(undefined, { sessions });
  host.apply();
  host.mount('s1');
  await tick();
  assert.deepEqual(sessions.calls, ['s1'], '挂载时拉一次');
  host.mount('s1');
  host.mount('s1');
  await tick();
  assert.deepEqual(sessions.calls, ['s1'], 'hydrated 锁保证每个会话只拉一次');
  host.dispose();
});

test('挂载回填完成后，第一次按 ↑ 就能翻到会话记录里最早的那条', async () => {
  const sessions = sessionHistoryService({
    s1: [
      persisted({ type: 'user/message', seq: 1, time: 1, data: { id: 'm1', content: [{ type: 'text', text: '最早的一句' }] } }),
      persisted({ type: 'user/message', seq: 9, time: 9, data: { content: '最新的一句' } }),
    ],
  });
  const host = await createHost(undefined, { sessions });
  host.apply();
  host.mount('s1');
  await tick();
  // 插件运行期间一条都没记过：第一次按 ↑ 就该是完整栈的最顶
  host.press('ArrowUp', 's1');
  host.press('ArrowUp', 's1');
  assert.deepEqual(host.writesOf('s1'), ['最新的一句', '最早的一句'], '两次 ↑ 直接翻到最早那条，不用先按一次等回填');
  host.dispose();
});

test('挂载即回填与按键路径不重复触发：hydrate 总共只发起一次', async () => {
  const sessions = sessionHistoryService({
    s1: [persisted({ type: 'user/message', seq: 3, time: 3, data: { content: '唯一一条' } })],
  });
  const host = await createHost(undefined, { sessions });
  host.apply();
  host.mount('s1');
  await tick();
  host.press('ArrowUp', 's1');
  host.press('ArrowUp', 's1');
  host.press('ArrowDown', 's1');
  await tick();
  assert.deepEqual(sessions.calls, ['s1'], '挂载已经拉过，按键路径不许再拉');
  host.dispose();
});

test('栈空时按 ↑ 不发起回填：回填已经前移到挂载点', async () => {
  const sessions = sessionHistoryService({ s1: [] });
  const host = await createHost(undefined, { sessions });
  host.apply();
  host.mount('s1');
  await tick();
  assert.deepEqual(sessions.calls, ['s1'], '挂载时拉过一次');
  host.press('ArrowUp', 's1');
  host.press('ArrowUp', 's1');
  await tick();
  assert.deepEqual(sessions.calls, ['s1'], '按键路径不再发起第二次读取');
  assert.deepEqual(host.writesOf('s1'), [], '没有历史就什么都不写');
  host.dispose();
});

test('会话记录读不到时只降级：挂载不抛，按键退回内存栈', async () => {
  // 只统计「读会话历史」这一类的 warn：装配阶段别的降级提示不该算进来
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => {
    warns.push(args);
  };
  try {
    const host = await createHost(undefined, { sessions: { binding: () => undefined } });
    assert.doesNotThrow(() => host.apply());
    assert.doesNotThrow(() => host.mount('s1'), '会话读不到不能炸掉挂载');
    await tick();
    assert.equal(warns.length, 1, '会话读不到只吵一次');
    assert.match(String(warns[0][0]), /s1/, 'warn 里必须带 sessionId，实机排查才有抓手');
    send(host, 's1', '内存里记的');
    host.press('ArrowUp', 's1');
    assert.deepEqual(host.writesOf('s1'), ['内存里记的'], '降级后仍是原来的内存行为');
    host.dispose();
  } finally {
    console.warn = original;
  }
});

test('回填失败时挂载不抛，warn 带上 sessionId 与错误原因', async () => {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => {
    warns.push(args);
  };
  try {
    const sessions = {
      binding() {
        throw new Error('网关挂了');
      },
    };
    const host = await createHost(undefined, { sessions });
    assert.doesNotThrow(() => host.apply());
    assert.doesNotThrow(() => host.mount('s1'));
    await tick();
    assert.equal(warns.length, 1, '失败只吵一次');
    assert.match(String(warns[0][0]), /s1/);
    assert.match(String(warns[0][1]), /网关挂了/, '错误原因要一起带出来');
    send(host, 's1', '内存里记的');
    host.press('ArrowUp', 's1');
    assert.deepEqual(host.writesOf('s1'), ['内存里记的']);
    host.dispose();
  } finally {
    console.warn = original;
  }
});

test('多实例：同一个模块两份接线不互清，宿主逐份停用旧 fiber', async () => {
  const shared = await loadApi();
  const first = await createHost(shared);
  first.apply();
  first.mount('s1');
  send(first, 's1', '甲');
  send(first, 's1', '乙');
  assert.equal(first.listeners.size, 1);

  const second = await createHost(shared);
  second.apply();
  assert.equal(first.listeners.size, 1, '新实例不能擅自清理另一份 fiber');
  first.dispose();
  assert.equal(first.listeners.size, 0, '宿主停用旧实例才移除旧观察者');
  second.mount('s1');
  send(second, 's1', '甲');
  send(second, 's1', '乙');
  second.press('ArrowUp', 's1');
  assert.deepEqual(second.writesOf('s1'), ['乙'], '一次按键只翻一条');
  second.dispose();
});

function addSelectionApi(record) {
  let selection = 'existing';
  record.shell.editor.getEditorState = () => ({
    clone(nextSelection) { return { selection: nextSelection, isEmpty: () => record.state.text.length === 0 }; },
  });
  record.shell.editor.setEditorState = (next) => { selection = next.selection; };
  record.shell.editor.focus = (_callback, options = {}) => {
    if (selection === null && options.defaultSelection === 'rootStart') {
      record.state.caret = 0;
      selection = 'start';
    }
  };
}

for (const [kind, text] of [
  ['显式换行', '第一行很长的中文内容\n第二行内容'],
  ['窄窗口自动折行', '这是一段没有换行符但是在窄窗口中会显示成多行的长文本'.repeat(5)],
]) {
  test(kind + '：方向键完整处理结束后光标在文首，不再执行浏览器默认上移', async () => {
    const host = await createHost();
    host.apply();
    host.mount('s1');
    const record = host.shellFor('s1');
    addSelectionApi(record);
    send(host, 's1', '更早的历史');
    send(host, 's1', text);
    let nativeMoves = 0;
    host.press('ArrowUp', 's1', { browserDefaultAction(state) { nativeMoves += 1; state.caret = 12; } });
    assert.equal(record.state.text, text);
    assert.equal(record.state.caret, 0, '检查的是整次 keydown 结束后的光标，不是 setDraft 刚执行时');
    assert.equal(nativeMoves, 0, '历史已经接管，本次 ↑ 默认动作必须停止');
    host.press('ArrowUp', 's1');
    assert.equal(record.state.text, '更早的历史', '继续按 ↑ 翻上一条');
    assert.equal(record.state.caret, 0);
    host.press('ArrowDown', 's1');
    assert.equal(record.state.text, text);
    assert.equal(record.state.caret, 0);
    host.dispose();
  });
}

test('翻到同文本的最旧记录仍定位文首，且不先清空文本', async () => {
  const host = await createHost();
  host.apply();
  host.mount('s1');
  const record = host.shellFor('s1');
  addSelectionApi(record);
  const calls = [];
  const original = record.shell.actions.setDraft;
  record.shell.actions.setDraft = (value) => { calls.push(value); original(value); };
  send(host, 's1', '同一条');
  host.press('ArrowUp', 's1');
  record.state.caret = 2;
  host.press('ArrowUp', 's1');
  assert.equal(record.state.caret, 0);
  assert.deepEqual(calls, ['同一条', '同一条'], '不再靠先写空串影响编辑器和撤销栈');
  host.dispose();
});

async function rootHarness(initial) {
  const { code } = await buildClientBundle();
  let registration; const intervals = new Map(); const children = []; const effects = [];
  const listeners = new Set(); const rows = new Set(); const slots = []; const localeListeners = new Set();
  let response = initial; let calls = 0; let bindings = 0; let rootStop;
  vm.runInNewContext(code, {
    window: { __ModuleLoader__: { load(value) { registration = value; } } }, console,
    setInterval(fn, ms) { const token = {}; intervals.set(token, { fn, ms }); return token; },
    clearInterval(token) { intervals.delete(token); }, setTimeout, clearTimeout,
  });
  const api = registration.factory(() => ({ useEffect() {} }));
  function context() {
    const cleanups = [];
    const ctx = {
      effect(fn) { const off = fn(); cleanups.push(off); return off; },
      locale: { getSnapshot: () => ({ active: 'zh-CN' }), resolveText: value => value.zh, subscribe(fn) { localeListeners.add(fn); return () => localeListeners.delete(fn); } },
      conversation: { input: { shell: () => null } },
      sessions: { binding() { bindings++; return undefined; } },
      shortcuts: { observeFixedInput(fn) { listeners.add(fn); return () => listeners.delete(fn); }, registerFixed(row) { rows.add(row); return () => rows.delete(row); } },
      slots: { inject(_name, fn) { return fn(); }, register(meta, Component) { const entry = { meta, Component }; slots.push(entry); return () => { const i = slots.indexOf(entry); if (i >= 0) slots.splice(i, 1); }; } },
      remote: { pluginInventory: { list: async () => { calls++; return response; } } },
      plugin(component) {
        const child = context(); component.apply(child.ctx);
        const fiber = { component, ctx: child.ctx, disposed: false, async dispose() { if (this.disposed) return; this.disposed = true; for (const off of child.cleanups.reverse()) await off?.(); } };
        children.push(fiber); return fiber;
      },
    };
    return { ctx, cleanups };
  }
  const root = context(); api.apply(root.ctx); rootStop = root.cleanups[0];
  const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  await settle();
  return { api, children, listeners, rows, slots, intervals, localeListeners, settle,
    setResponse(value) { response = value; }, calls: () => calls, bindings: () => bindings,
    async poll() { for (const timer of intervals.values()) timer.fn(); await settle(); }, dispose: rootStop,
  };
}

function nativeInventory(history, retry) {
  return { ok: true, value: { entries: [
    { entryId: 'include:demo:dsh-replay.history', moduleName: '@bxzy/dsh-replay/history', enabled: history },
    { entryId: 'include:demo:dsh-replay.retry', moduleName: '@bxzy/dsh-replay/retry', enabled: retry },
  ] } };
}

test('root owns one 1000ms poll and isolated real business callbacks; all four native states work', async () => {
  for (const [history, retry] of [[false, false], [true, false], [false, true], [true, true]]) {
    const h = await rootHarness(nativeInventory(history, retry));
    assert.equal(h.intervals.size, 1); assert.equal([...h.intervals.values()][0].ms, 1000);
    assert.equal(h.listeners.size, history ? 1 : 0); assert.equal(h.rows.size, history ? 2 : 0);
    assert.equal(h.slots.filter(s => s.meta.key === 'user' && s.meta.priority === -1).length, retry ? 1 : 0);
    assert.equal(h.children.length, Number(history) + Number(retry));
    if (h.children.length === 2) assert.notEqual(h.children[0].ctx, h.children[1].ctx);
    await h.dispose(); assert.equal(h.intervals.size, 0); assert.equal(h.listeners.size, 0);
    assert.equal(h.rows.size, 0); assert.equal(h.slots.length, 0); assert.equal(h.localeListeners.size, 0);
  }
});

test('root poll actually removes history resources and retry shadow, restoring builtin candidate', async () => {
  const h = await rootHarness(nativeInventory(true, true));
  const builtin = { meta: { name: 'conversation.chat.node', key: 'user', priority: 0 }, Component: function NativeUser() {} };
  h.slots.push(builtin); const candidate = () => h.slots.filter(s => s.meta.key === 'user').sort((a,b) => a.meta.priority - b.meta.priority)[0];
  assert.notEqual(candidate(), builtin); const retryFiber = h.children.find(c => c.component.name === 'dsh-replay.retry');
  h.setResponse(nativeInventory(false, true)); await h.poll();
  assert.equal(h.listeners.size, 0); assert.equal(h.rows.size, 0); assert.equal(retryFiber.disposed, false);
  assert.equal(h.bindings(), 0, 'disabled history cannot read sessions');
  h.setResponse(nativeInventory(false, false)); await h.poll(); assert.equal(candidate(), builtin);
  h.setResponse(nativeInventory(true, true)); await h.poll(); await h.poll();
  assert.equal(h.listeners.size, 1); assert.equal(h.rows.size, 2);
  assert.equal(h.slots.filter(s => s.meta.key === 'user' && s.meta.priority === -1).length, 1);
  await h.dispose(); assert.equal(candidate(), builtin);
});

test('root disposal clears its timer immediately and drops late inventory response', async () => {
  let resolve; const delayed = new Promise(done => { resolve = done; });
  const h = await rootHarness(delayed);
  assert.equal(h.calls(), 1); await h.poll(); assert.equal(h.calls(), 1);
  await h.dispose(); assert.equal(h.intervals.size, 0);
  resolve(nativeInventory(true, true)); await h.settle(); assert.equal(h.children.length, 0);
});
