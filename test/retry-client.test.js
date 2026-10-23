import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function loadRetryClient() {
  const files = ['prompt', 'clipboard', 'retry', 'retry-client'];
  const sources = await Promise.all(files.map(file => readFile(new URL('../src/' + file + '.js', import.meta.url), 'utf8')));
  const names = sources.flatMap(source => [...source.matchAll(/^export\s+(?:const|function)\s+(\w+)/gm)].map(match => match[1]));
  const body = sources.map(source => source
    .replace(/^import[^;]*;\r?\n/gm, '')
    .replace(/^export\s+\{[^}]*\}[^;]*;\r?\n/gm, '')
    .replace(/^export\s+(?=(?:const|function)\s)/gm, '')).join('\n');
  return vm.runInNewContext('(function(React){' + body + '\nreturn {' + names.join(',') + '};})({})', {
    console: { info() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
  });
}
const api = await loadRetryClient();
const i18n = { t: key => key, language: () => 'en-US' };

function createHost({ sessions, returnsDisposer = true, deferred = false } = {}) {
  const native = { meta: { name: 'conversation.chat.node', key: 'user', priority: 0 }, Component: 'native-user' };
  const entries = new Set([native]);
  const effects = [];
  const injections = [];
  const promptCalls = [];
  let cancelCalls = 0;
  const ctx = {
    sessions: sessions ?? {
      binding: () => ({ session: {
        prompt: async (...args) => { promptCalls.push(args); return { ok: true }; },
        cancel: () => { cancelCalls += 1; },
      } }),
    },
    effect(setup) {
      const cleanup = setup();
      if (typeof cleanup === 'function') effects.push(cleanup);
      return cleanup;
    },
    slots: {
      register(meta, Component) {
        const entry = { meta, Component };
        entries.add(entry);
        return () => { entries.delete(entry); };
      },
      inject(name, callback) {
        let cleanup;
        let closed = false;
        const run = () => { cleanup = callback(); };
        const stop = () => { if (!closed) { closed = true; cleanup?.(); } };
        injections.push({ name, run, stop });
        if (!deferred) run();
        if (returnsDisposer) return stop;
        effects.push(stop);
      },
    },
  };
  return {
    ctx, entries, native, effects, injections, promptCalls,
    get cancelCalls() { return cancelCalls; },
    selected: () => [...entries].filter(entry => entry.meta.key === 'user').sort((a, b) => a.meta.priority - b.meta.priority)[0],
    dispose: () => { for (const stop of [...effects].reverse()) stop(); },
  };
}

test('两个独立 ctx 不互清：第二实例 apply 不能停第一实例，关闭只清自己', async () => {
  const first = createHost();
  const second = createHost();
  api.applyMessageRetry(first.ctx, i18n);
  const firstAction = first.selected().meta.inject('s1').retry;
  api.applyMessageRetry(second.ctx, i18n);
  assert.equal(first.selected().Component, api.UserMessageView);
  second.dispose();
  assert.equal(first.selected().Component, api.UserMessageView);
  assert.equal(second.selected(), second.native);
  assert.equal((await firstAction('s1', '仍可重试')).ok, true);
  assert.equal(first.promptCalls.length, 1);
  first.dispose();
});

test('关闭后旧 action 拒绝新 prompt，但关闭前已发出的 queue prompt 不 cancel', async () => {
  let resolve;
  const calls = [];
  let cancels = 0;
  const host = createHost({ sessions: { binding: () => ({ session: {
    prompt: (...args) => { calls.push(args); return new Promise(done => { resolve = done; }); },
    cancel: () => { cancels += 1; },
  } }) } });
  api.applyMessageRetry(host.ctx, i18n);
  const action = host.selected().meta.inject('s1').retry;
  const pending = action('s1', '已接纳');
  host.dispose();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2, '只传文本和 queue，requestId 不传');
  assert.equal(calls[0][1], 'queue');
  const closed = action('s1', '不能新增');
  assert.equal(calls.length, 1, '旧 action 不能向宿主发新 prompt');
  assert.equal((await closed).ok, false);
  resolve({ ok: true });
  assert.equal((await pending).ok, true, '已发出的请求保留宿主结果');
  assert.equal(cancels, 0);
  assert.equal(host.selected(), host.native);
});

test('slots.inject 自有 lifecycle 不返回函数时也随 ctx 关闭，延迟 callback 不可复活槽', () => {
  for (const returnsDisposer of [true, false]) {
    const host = createHost({ returnsDisposer, deferred: true });
    api.applyMessageRetry(host.ctx, i18n);
    host.dispose();
    host.injections[0].run();
    assert.equal(host.entries.size, 1);
    assert.equal(host.selected(), host.native);
  }
});

test('关闭重开三轮始终只有一个 user/-1 候选，不遮蔽 steering、不留注册', () => {
  const host = createHost();
  const steering = { meta: { key: 'steering', priority: 0 }, Component: 'native-steering' };
  host.entries.add(steering);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    api.applyMessageRetry(host.ctx, i18n);
    assert.equal([...host.entries].filter(entry => entry.meta.key === 'user' && entry.meta.priority === -1).length, 1);
    host.dispose();
    assert.equal(host.entries.size, 2);
    assert.equal(host.selected(), host.native);
    assert.ok(host.entries.has(steering));
  }
});

test('缺 sessions 或 user/-1 注册冲突只退回内置 renderer，不触碰其它功能', () => {
  const missing = createHost();
  delete missing.ctx.sessions;
  assert.doesNotThrow(() => api.applyMessageRetry(missing.ctx, i18n));
  assert.equal(missing.injections.length, 0);
  assert.equal(missing.selected(), missing.native);
  const conflict = createHost();
  conflict.ctx.slots.register = () => { throw new Error('same keyed priority'); };
  assert.doesNotThrow(() => api.applyMessageRetry(conflict.ctx, i18n));
  assert.equal(conflict.selected(), conflict.native);
  conflict.dispose();
});

test('会话 binding 同步触发停用后也不得开始 prompt', async () => {
  let calls = 0;
  const host = createHost({ sessions: { binding: () => {
    host.dispose();
    return { session: { prompt: () => { calls += 1; } } };
  } } });
  api.applyMessageRetry(host.ctx, i18n);
  const action = host.selected().meta.inject('s1').retry;
  assert.equal((await action('s1', '文本')).ok, false);
  assert.equal(calls, 0);
});

test('原生 Entry 关闭注销 user/-1 候选并恢复宿主内置 renderer', () => {
  const host = createHost();
  api.applyMessageRetry(host.ctx, i18n);
  assert.equal(host.selected().Component, api.UserMessageView);
  assert.equal(host.entries.size, 2);
  assert.deepEqual(Array.from(api.injectMessageRetry), ['slots', 'sessions']);
  host.dispose();
  host.dispose();
  assert.equal(host.selected(), host.native, '必须删除候选，不是隐藏图标');
  assert.equal(host.entries.size, 1);
});
