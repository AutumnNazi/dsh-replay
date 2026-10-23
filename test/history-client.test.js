import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createComposers } from '../src/composer.js';

function reactShim() {
  let bucket;
  return {
    api: { useEffect(fn) { bucket?.push(fn); } },
    render(Component, props) {
      bucket = [];
      assert.equal(Component(props), null);
      const effects = bucket;
      bucket = undefined;
      return effects;
    },
  };
}

// 独立入口尚未纳入 root bundle 时，只转换本任务依赖的静态 ESM。
async function loadHistoryClient(shim) {
  const cache = new Map();
  const logs = [];
  const overrides = {
    react: shim.api,
  };
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    let source = await readFile(new URL('../src/' + file, import.meta.url), 'utf8');
    const imports = [];
    for (const match of source.matchAll(/^import (.*?) from ['"](.*?)['"];$/gm)) {
      imports.push([match[0], match[1], overrides[match[2]] ?? await load(match[2].slice(2))]);
    }
    const names = [...source.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((match) => match[1]);
    for (const [line, binding] of imports) {
      const at = imports.findIndex((item) => item[0] === line);
      source = source.replace(line, binding.startsWith('* as ') ? 'const ' + binding.slice(5) + ' = imports[' + at + '];' : 'const ' + binding + ' = imports[' + at + '];');
    }
    source = source.replace(/^export /gm, '');
    const exports = vm.runInNewContext('(function(imports) {' + source + '\nreturn {' + names.join(',') + '}; })', {
      console: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
      Map, Set, Object, Array, String, Number,
    })(imports.map((item) => item[2]));
    cache.set(file, exports);
    return exports;
  }
  const api = await load('history-client.js');
  return { apply: api.applyInputHistory, logs };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const message = (text) => ({ type: 'persistent', event: { type: 'user/message', data: { content: text } } });

async function createHost(shared, sessions) {
  const shim = shared?.shim ?? reactShim();
  const api = shared?.api ?? await loadHistoryClient(shim);
  const listeners = new Set();
  const rows = new Set();
  const registrations = new Set();
  const effects = [];
  const records = new Map();
  const slotCallbacks = [];
  const consumed = [];
  const counts = { observerOff: 0, rowOff: 0, slotOff: 0, registerOff: 0, subscribe: 0, unsubscribe: 0 };
  function record(id = 's1') {
    if (records.has(id)) return records.get(id);
    const state = { text: '', references: [], caret: 0, writes: [], subs: new Set(), oldSubs: [], editorOps: [], fail: false };
    const root = { contains: (target) => target?.sessionId === id };
    const notify = () => { for (const fn of [...state.subs]) fn(); };
    const shell = {
      get projection() { return { clipboardText: state.text, detectText: state.text, caret: state.caret, occurrences: state.references }; },
      actions: { setDraft(value) {
        if (state.fail) throw new Error('host write failed');
        state.writes.push(value);
        state.text = typeof value === 'string' ? value : value.text;
        state.references = typeof value === 'string' ? [] : value.references;
        state.caret = state.text.length;
        notify();
      } },
      editor: {
        getRootElement: () => root,
        getEditorState: () => ({ clone: (selection) => { state.editorOps.push(['clone', selection]); return {}; } }),
        setEditorState: () => state.editorOps.push(['setEditorState']),
        focus: (_callback, options) => { state.editorOps.push(['focus', options.defaultSelection]); state.caret = 0; },
      },
      state: {
        getSnapshot: () => ({ draft: state.text }),
        subscribe(fn) { counts.subscribe++; state.subs.add(fn); state.oldSubs.push(fn); return () => { counts.unsubscribe++; state.subs.delete(fn); }; },
      },
    };
    const value = { state, root, shell, notify };
    records.set(id, value);
    return value;
  }
  const ctx = {
    sessions,
    conversation: { input: { shell: (id) => record(id).shell } },
    effect(fn) { const off = fn(); effects.push(off); return off; },
    shortcuts: {
      observeFixedInput(fn) { listeners.add(fn); return () => { counts.observerOff++; listeners.delete(fn); }; },
      registerFixed(row) { rows.add(row); return () => { counts.rowOff++; rows.delete(row); }; },
    },
    slots: {
      inject(_name, fn) {
        slotCallbacks.push(fn);
        const off = fn();
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          counts.slotOff++;
          if (typeof off === 'function') off();
        };
      },
      register(meta, Component) { const entry = { meta, Component }; registrations.add(entry); return () => { counts.registerOff++; registrations.delete(entry); }; },
    },
  };
  const host = {
    shim, api, ctx, listeners, rows, registrations, slotCallbacks, counts, record, consumed,
    apply() { api.apply(ctx, { t: (key, params) => key + (params?.sessionId ? ':' + params.sessionId : '') }); },
    close() { for (const off of [...effects].reverse()) if (typeof off === 'function') off(); },
    anchor() { return [...registrations].find((entry) => entry.meta.name === 'conversation.composer.dock'); },
    render(id = 's1') { const entry = this.anchor(); assert.ok(entry); return shim.render(entry.Component, entry.meta.inject(id)); },
    mount(id = 's1') { return this.render(id).map((effect) => effect()); },
    input(code = 'ArrowUp', extra = {}, id = 's1') {
      return { type: 'keydown', gesture: { code, ...extra }, context: { region: 'editable', target: record(id).root }, consume: () => consumed.push(code) };
    },
    key(code = 'ArrowUp', extra = {}, id = 's1') { const input = this.input(code, extra, id); for (const fn of [...listeners]) fn(input); },
  };
  return host;
}

test('登记簿 dispose 后旧订阅、mount 和写回都不复活', () => {
  let reads = 0;
  let subscribes = 0;
  let unsubscribes = 0;
  let writes = 0;
  let callback;
  const shell = {
    state: {
      getSnapshot: () => { reads++; return { draft: '草稿' }; },
      subscribe(fn) { subscribes++; callback = fn; return () => { unsubscribes++; }; },
    },
    actions: { setDraft() { writes++; } },
  };
  const composers = createComposers({ input: { shell: () => shell } });
  composers.mount('s1');
  assert.equal(reads, 1);
  composers.dispose();
  composers.dispose();
  callback();
  composers.mount('s1');
  assert.equal(reads, 1);
  assert.equal(subscribes, 1);
  assert.equal(unsubscribes, 1);
  assert.equal(composers.lastNonEmptyDraftOf('s1'), null);
  assert.equal(composers.writeDraft(shell, '旧回调文本'), false);
  assert.equal(writes, 0);
});

test('旧 Anchor 延迟 commit、槽回调和按键在关闭后均不复活；dispose 幂等', async () => {
  let bindings = 0;
  const host = await createHost(undefined, { binding: () => { bindings++; return { session: { openState: 'open', hasMore: false } }; } });
  host.apply();
  const delayed = host.render();
  const staleObserver = [...host.listeners][0];
  const staleSlot = host.slotCallbacks[0];
  const state = host.record().state;
  state.text = '当前草稿';
  host.close();
  host.close();
  for (const effect of delayed) effect();
  staleSlot();
  staleObserver(host.input());
  await settle();
  assert.equal(bindings, 0);
  assert.equal(host.counts.subscribe, 0);
  assert.equal(host.listeners.size, 0);
  assert.equal(host.rows.size, 0);
  assert.equal(host.registrations.size, 0);
  assert.deepEqual(host.counts, { observerOff: 1, rowOff: 2, slotOff: 1, registerOff: 1, subscribe: 0, unsubscribe: 0 });
  assert.equal(state.text, '当前草稿');
  assert.equal(state.writes.length, 0);
  assert.equal(host.consumed.length, 0);
});

test('关闭在途 open 后不再发 loadOlder、不写草稿或消费按键', async () => {
  const opening = deferred();
  let open = 0;
  let older = 0;
  const session = { openState: 'loading', hasMore: true, open: () => { open++; return opening.promise; }, loadOlder: async () => { older++; } };
  const host = await createHost(undefined, { binding: () => ({ session, eventSource: { getSnapshot: () => ({ entries: [message('旧历史')] }) } }) });
  host.apply();
  host.mount();
  assert.equal(open, 1);
  const state = host.record().state;
  state.text = '当前草稿';
  host.close();
  opening.resolve();
  await settle();
  assert.equal(older, 0);
  assert.equal(state.text, '当前草稿');
  assert.equal(state.writes.length, 0);
  assert.equal(host.consumed.length, 0);
});


test('解绑并重开重新回填，↑ 从最新起步且 ↓ 恢复当前含引用草稿', async () => {
  let entries = [message('甲'), message('乙')];
  const host = await createHost(undefined, { binding: () => ({ session: { openState: 'open', hasMore: false }, eventSource: { getSnapshot: () => ({ entries }) } }) });
  host.apply();
  host.mount();
  await settle();
  const { state, notify } = host.record();
  state.text = '旧 stash';
  state.caret = 0;
  notify();
  host.key();
  host.key();
  assert.equal(state.text, '甲');
  const stale = [...host.listeners][0];
  const oldSub = state.oldSubs[0];
  host.close();
  assert.equal(state.text, '甲');
  assert.equal(state.subs.size, 0);
  assert.equal(host.registrations.size, 0);
  entries = [message('甲'), message('乙'), message('新消息')];
  state.text = '当前 @ref 草稿';
  state.references = [{ id: 'ref', label: 'ref' }];
  state.caret = 0;
  const draftReferences = state.references;
  host.apply();
  host.mount();
  await settle();
  oldSub();
  stale(host.input());
  assert.equal(state.text, '当前 @ref 草稿');
  host.key();
  assert.equal(state.text, '新消息');
  host.key('ArrowDown');
  assert.equal(state.text, '当前 @ref 草稿');
  assert.equal(state.references, draftReferences);
  assert.equal(host.listeners.size, 1);
  assert.equal(host.rows.size, 2);
  assert.equal(host.registrations.size, 1);
  assert.equal(state.subs.size, 1);
  host.close();
  assert.equal(host.counts.subscribe, 2);
  assert.equal(host.counts.unsubscribe, 2);
});

test('同模块两个 Entry 不互清，关一份不影响另一份仓库和订阅', async () => {
  const first = await createHost();
  const second = await createHost(first);
  first.apply();
  first.mount();
  first.record().state.text = '第一份记录';
  first.record().notify();
  first.key('Enter');
  second.apply();
  second.mount();
  second.record().state.text = '第二份记录';
  second.record().notify();
  second.key('Enter');
  assert.equal(first.listeners.size, 1);
  first.key();
  assert.equal(first.record().state.text, '第一份记录');
  first.close();
  assert.equal(second.listeners.size, 1);
  assert.equal(second.rows.size, 2);
  assert.equal(second.registrations.size, 1);
  assert.equal(second.record().state.subs.size, 1);
  second.key();
  assert.equal(second.record().state.text, '第二份记录');
  assert.equal(second.consumed.length, 1);
  second.close();
});

test('首行多行与文首写回保持 clone(null) → rootStart，浏览与 ↓ 原草稿不变', async () => {
  const entries = [message('甲\n乙'), message('很长的自动换行文本'.repeat(30))];
  const host = await createHost(undefined, { binding: () => ({ session: { openState: 'open', hasMore: false }, eventSource: { getSnapshot: () => ({ entries }) } }) });
  host.apply();
  host.mount();
  await settle();
  const state = host.record().state;
  state.text = '第一行\n第二行';
  state.caret = 4;
  host.key();
  assert.equal(state.writes.length, 0);
  state.caret = 0;
  host.key();
  assert.equal(state.text, entries[1].event.data.content);
  assert.equal(state.caret, 0);
  assert.deepEqual(state.editorOps.slice(0, 3), [['clone', null], ['setEditorState'], ['focus', 'rootStart']]);
  host.key();
  assert.equal(state.text, '甲\n乙');
  state.caret = state.text.length;
  host.key('ArrowDown');
  host.key('ArrowDown');
  assert.equal(state.text, '第一行\n第二行');
  assert.equal(state.caret, 0);
  host.close();
});

test('IME、修饰键、已消费、非本 composer 与写回失败均让路', async () => {
  const host = await createHost();
  host.apply();
  host.mount();
  const state = host.record().state;
  state.text = '已发送';
  host.record().notify();
  host.key('Enter');
  for (const extra of [{ composing: true }, { shift: true }, { alt: true }, { control: true }, { meta: true }, { defaultPrevented: true }]) host.key('ArrowUp', extra);
  const outside = host.input();
  outside.context.target = {};
  for (const fn of host.listeners) fn(outside);
  assert.equal(state.writes.length, 0);
  assert.equal(host.consumed.length, 0);
  state.fail = true;
  host.key();
  assert.equal(state.writes.length, 0);
  assert.equal(host.consumed.length, 0);
  state.fail = false;
  host.key();
  assert.equal(state.writes.length, 1);
  assert.equal(host.consumed.length, 1);
  host.close();
});

test('关闭在途 loadOlder 后不再读取 snapshot、回填或告警；共享宿主请求不 cancel', async () => {
  for (const failed of [false, true]) {
    const loading = deferred();
    let older = 0;
    let snapshots = 0;
    let cancel = 0;
    const host = await createHost(undefined, { binding: () => ({
      session: { openState: 'open', hasMore: true, loadOlder: () => { older++; return loading.promise; }, cancel: () => { cancel++; } },
      eventSource: { getSnapshot: () => { snapshots++; return { entries: [message('旧历史')] }; } },
    }) });
    host.apply();
    host.mount();
    assert.equal(older, 1);
    host.close();
    if (failed) loading.reject(new Error('宿主失败'));
    else loading.resolve();
    await settle();
    assert.equal(snapshots, 0);
    assert.equal(cancel, 0);
    assert.equal(host.api.logs.length, 0);
    assert.equal(host.record().state.writes.length, 0);
  }
});

test('读取器保留旧用户消息口径，排除 transient 与非用户事件，单次 hasMore 仅续一页', async () => {
  let older = 0;
  const host = await createHost(undefined, { binding: () => ({
    session: { openState: 'open', hasMore: true, loadOlder: async () => { older++; } },
    eventSource: { getSnapshot: () => ({ entries: [
      message('有效'),
      { ...message('瞬时'), type: 'transient' },
      { type: 'persistent', event: { type: 'assistant/message', data: { content: '助手' } } },
      { type: 'persistent', event: { type: 'user/message', surfaceOp: 'replace', data: { content: '替换副本' } } },
      { type: 'persistent', event: { type: 'user/message', data: { source: { kind: 'tool' }, content: '工具' } } },
      message(''),
    ] }) },
  }) });
  host.apply();
  host.mount();
  await settle();
  assert.equal(older, 1);
  host.key();
  assert.equal(host.record().state.text, '有效');
  await settle();
  assert.equal(older, 2);
  host.close();
});


test('原生接线 ID 与固定清单 label 只来自注入词典', async () => {
  const host = await createHost();
  host.apply();
  assert.equal(host.anchor().meta.id, 'dsh-replay.history');
  const rows = [...host.rows];
  assert.deepEqual(rows.map((row) => row.id), ['dsh-replay.history.prev', 'dsh-replay.history.next']);
  assert.deepEqual(rows.map((row) => row.label()), ['history.prev', 'history.next']);
  assert.deepEqual(rows.map((row) => Array.from(row.keys)), [['↑'], ['↓']]);
  assert.deepEqual(rows.map((row) => row.bindings[0].code), ['ArrowUp', 'ArrowDown']);
  host.close();
});
