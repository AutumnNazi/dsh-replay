import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, isFirstLine, isRecallTrigger } from '../src/history.js';
import { classifyInput, decideAction } from '../src/intent.js';

// ── 纯状态机 ────────────────────────────────────────────────────────────────

test('空历史按 ↑ 不动作：没有可翻的条目时交还 null，输入框保持原样', () => {
  const history = createHistory();
  assert.equal(history.up('s1', ''), null);
  assert.equal(history.isBrowsing('s1'), false);
});

test('逐条回翻：连续按 ↑ 依次给出最新一条、次新一条', () => {
  const history = createHistory();
  history.push('s1', '第一条');
  history.push('s1', '第二条');
  history.push('s1', '第三条');
  assert.equal(history.up('s1', ''), '第三条');
  assert.equal(history.up('s1', ''), '第二条');
  assert.equal(history.up('s1', ''), '第一条');
});

test('翻到最旧一条后停住：再按 ↑ 仍是同一条，不循环也不清空', () => {
  const history = createHistory();
  history.push('s1', '甲');
  history.push('s1', '乙');
  assert.equal(history.up('s1', ''), '乙');
  assert.equal(history.up('s1', ''), '甲');
  assert.equal(history.up('s1', ''), '甲');
  assert.equal(history.up('s1', ''), '甲');
  assert.equal(history.isBrowsing('s1'), true);
});

test('↓ 回退到翻历史前那份草稿：非空草稿必须原样还回来', () => {
  const history = createHistory();
  history.push('s1', '发过的消息');
  assert.equal(history.up('s1', '我正在写的草稿'), '发过的消息');
  assert.equal(history.down('s1'), '我正在写的草稿');
  assert.equal(history.isBrowsing('s1'), false);
});

test('最旧之后一路 ↓ 回到草稿，再按 ↓ 交还 null（不接管）', () => {
  const history = createHistory();
  history.push('s1', '甲');
  history.push('s1', '乙');
  history.up('s1', '草稿');
  history.up('s1', '草稿');
  assert.equal(history.down('s1'), '乙');
  assert.equal(history.down('s1'), '草稿');
  assert.equal(history.down('s1'), null);
});

test('空输入框翻历史：草稿槽位记的是空串，↓ 恢复成空串而不是 null', () => {
  const history = createHistory();
  history.push('s1', '上一条');
  assert.equal(history.up('s1', ''), '上一条');
  assert.equal(history.down('s1'), '');
});

test('会话隔离：两个 sessionId 交错翻历史互不污染', () => {
  const history = createHistory();
  history.push('a', 'A-1');
  history.push('a', 'A-2');
  history.push('b', 'B-1');
  assert.equal(history.up('a', '草稿A'), 'A-2');
  assert.equal(history.up('b', '草稿B'), 'B-1');
  assert.equal(history.up('a', '草稿A'), 'A-1');
  assert.equal(history.isBrowsing('b'), true);
  assert.equal(history.down('b'), '草稿B');
  // b 回到草稿不影响 a 仍在回翻
  assert.equal(history.isBrowsing('a'), true);
  assert.equal(history.up('a', '草稿A'), 'A-1');
  assert.deepEqual(history.entries('b'), ['B-1']);
});

test('push 的边界：空白不入栈、与上一条重复不入栈、超上限丢最旧', () => {
  const history = createHistory({ limit: 3 });
  assert.equal(history.push('s1', '   '), false);
  assert.equal(history.push('s1', '甲'), true);
  assert.equal(history.push('s1', '甲'), false);
  history.push('s1', '乙');
  history.push('s1', '丙');
  history.push('s1', '丁');
  assert.deepEqual(history.entries('s1'), ['乙', '丙', '丁']);
});

test('reset 退出回翻并丢掉草稿槽位', () => {
  const history = createHistory();
  history.push('s1', '甲');
  history.up('s1', '草稿');
  history.reset('s1');
  assert.equal(history.isBrowsing('s1'), false);
  assert.equal(history.down('s1'), null);
});

test('dispose 使在途回填失效，重复关闭和旧仓库调用不复活', async () => {
  const history = createHistory();
  assert.equal(typeof history.dispose, 'function');
  let resolve;
  const pending = history.hydrate('s1', () => new Promise((done) => { resolve = done; }));
  history.push('s1', '仅内存');
  history.dispose();
  history.dispose();
  resolve(['旧回填']);
  assert.equal(await pending, false);
  assert.deepEqual(history.entries('s1'), []);
  assert.equal(history.push('s1', '关闭后输入'), false);
  assert.equal(history.up('s1', '当前草稿'), null);
  let calls = 0;
  assert.equal(await history.hydrate('s1', () => { calls++; return ['再读']; }), false);
  assert.equal(await history.loadMore('s1', () => { calls++; return ['再读']; }), false);
  assert.equal(calls, 0);
});

test('关闭在途 loadMore 丢弃结果与错误，新仓库不继承旧游标和 stash', async () => {
  for (const failed of [false, true]) {
    const history = createHistory();
    await history.hydrate('s1', async () => ({ texts: ['旧尾部'], hasMore: true }));
    history.up('s1', '旧 stash');
    let resolve;
    let reject;
    const pending = history.loadMore('s1', () => new Promise((yes, no) => { resolve = yes; reject = no; }));
    history.dispose();
    const fresh = createHistory();
    await fresh.hydrate('s1', async () => ({ texts: ['新尾部'], hasMore: false }));
    if (failed) reject(new Error('旧请求失败'));
    else resolve({ texts: ['更早', '旧尾部'], hasMore: false });
    assert.equal(await pending, false);
    assert.deepEqual(history.entries('s1'), []);
    assert.equal(history.isBrowsing('s1'), false);
    assert.equal(history.canLoadMore('s1'), false);
    assert.equal(fresh.isBrowsing('s1'), false);
    assert.equal(fresh.up('s1', '新草稿'), '新尾部');
    assert.equal(fresh.down('s1'), '新草稿');
  }
});

test('默认保留超过 2000 条内存输入，关闭后不再保存任何输入', () => {
  const history = createHistory();
  for (let i = 0; i < 2001; i++) history.push('s1', String(i));
  assert.equal(history.entries('s1').length, 2001);
  assert.equal(history.entries('s1')[0], '0');
  assert.equal(history.up('s1', '草稿'), '2000');
  history.dispose();
  assert.deepEqual(history.entries('s1'), []);
});

// ── 首行判定 ────────────────────────────────────────────────────────────────

test('isFirstLine：光标在换行之前算首行，越过换行就不算', () => {
  const text = '第一行\n第二行';
  assert.equal(isFirstLine(text, 0), true);
  assert.equal(isFirstLine(text, 3), true);
  assert.equal(isFirstLine(text, 4), false);
  assert.equal(isFirstLine(text, text.length), false);
});

test('isFirstLine：越界或非整数的光标一律判否，绝不误判成首行', () => {
  assert.equal(isFirstLine('abc', -1), false);
  assert.equal(isFirstLine('abc', 99), false);
  assert.equal(isFirstLine('abc', 1.5), false);
  assert.equal(isFirstLine('abc', null), false);
  assert.equal(isFirstLine(null, 0), false);
});

test('isRecallTrigger：空输入框触发，非空首行触发，非空非首行不触发', () => {
  assert.equal(isRecallTrigger('', 0), true);
  assert.equal(isRecallTrigger('   ', 3), true);
  assert.equal(isRecallTrigger('只有一行', 2), true);
  assert.equal(isRecallTrigger('第一行\n第二行', 8), false);
});

test('isRecallTrigger：有选区（caret 为 null）时不接管，让原生折叠选区行为走', () => {
  assert.equal(isRecallTrigger('第一行\n第二行', null), false);
});

// ── 意图判定 ────────────────────────────────────────────────────────────────

/** 造一份 observeFixedInput 交给监听者的输入。 */
function keyInput(code, overrides = {}) {
  const gesture = {
    code,
    control: false,
    alt: false,
    shift: false,
    meta: false,
    repeat: false,
    composing: false,
    defaultPrevented: false,
    ...(overrides.gesture ?? {}),
  };
  const context = { region: 'editable', modal: null, target: {}, ...(overrides.context ?? {}) };
  return { type: overrides.type ?? 'keydown', gesture, context, consume() {} };
}

test('方向键分类：裸 ↑ 是 prev，裸 ↓ 是 next', () => {
  assert.deepEqual(classifyInput(keyInput('ArrowUp')), { kind: 'prev' });
  assert.deepEqual(classifyInput(keyInput('ArrowDown')), { kind: 'next' });
});

test('Lexical 已消费（defaultPrevented）时让路：命令菜单/浮层吃掉的方向键绝不抢', () => {
  assert.equal(classifyInput(keyInput('ArrowUp', { gesture: { defaultPrevented: true } })).reason, 'consumed');
});

test('输入法组合中让路', () => {
  assert.equal(classifyInput(keyInput('ArrowUp', { gesture: { composing: true } })).reason, 'composing');
});

test('带修饰键的方向键让路：Shift 是扩选、Ctrl/Alt/Meta 是别的语义', () => {
  for (const modifier of ['shift', 'alt', 'control', 'meta']) {
    assert.equal(classifyInput(keyInput('ArrowUp', { gesture: { [modifier]: true } })).reason, 'modifier', modifier);
  }
});

test('context.modal 非空也照常翻：设置页 DOM 残留会让它恒非空，不能据此让路', () => {
  assert.equal(classifyInput(keyInput('ArrowUp', { context: { modal: 'other' } })).kind, 'prev');
  assert.equal(classifyInput(keyInput('ArrowDown', { context: { modal: 'settings' } })).kind, 'next');
});

test('焦点不在可编辑区域时让路', () => {
  assert.equal(classifyInput(keyInput('ArrowUp', { context: { region: 'page' } })).reason, 'region');
  assert.equal(classifyInput(keyInput('ArrowUp', { context: { region: 'terminal' } })).reason, 'region');
});

test('宿主的 reset 广播与无关按键一律不动', () => {
  assert.equal(classifyInput({ type: 'reset' }).reason, 'not-keydown');
  assert.equal(classifyInput(keyInput('KeyA')).reason, 'other-key');
});

test('回车记一条：允许 Ctrl/Meta 发送，排除 Shift+Enter 换行与长按连发', () => {
  assert.equal(classifyInput(keyInput('Enter')).kind, 'record');
  assert.equal(classifyInput(keyInput('Enter', { gesture: { control: true } })).kind, 'record');
  assert.equal(classifyInput(keyInput('Enter', { gesture: { meta: true } })).kind, 'record');
  assert.equal(classifyInput(keyInput('Enter', { gesture: { shift: true } })).reason, 'modifier');
  assert.equal(classifyInput(keyInput('Enter', { gesture: { repeat: true } })).reason, 'repeat');
});

test('回车即使被 Lexical preventDefault 也照样记：否则历史永远记不到东西', () => {
  assert.equal(classifyInput(keyInput('Enter', { gesture: { defaultPrevented: true } })).kind, 'record');
});

test('decideAction：非空且光标不在首行时不动手，↑ 保持原生光标上移', () => {
  const decision = decideAction('prev', { text: '第一行\n第二行', caret: 8, browsing: false });
  assert.equal(decision.act, false);
  assert.equal(decision.reason, 'not-first-line');
});

test('decideAction：非空但光标在首行时动手', () => {
  assert.equal(decideAction('prev', { text: '第一行\n第二行', caret: 2, browsing: false }).act, true);
});

test('decideAction：不在回翻状态时 ↓ 一律不接管', () => {
  assert.equal(decideAction('next', { text: '', caret: 0, browsing: false }).reason, 'not-browsing');
});

test('decideAction：回翻中不要求首行，多行历史条目也能继续往前翻', () => {
  // 写回多行条目后宿主把光标落在末尾（第 N 行），此时仍必须能继续 ↑
  assert.equal(decideAction('prev', { text: '甲\n乙\n丙', caret: 5, browsing: true }).act, true);
  assert.equal(decideAction('next', { text: '甲\n乙\n丙', caret: 5, browsing: true }).act, true);
});

// ── 从会话记录回填历史 ──────────────────────────────────────────────────────
// 用户要求：按 ↑ 要能翻出该会话历史上所有发过的话，不只是插件运行期间记的。
// 回填由会话挂载触发（client.js），这里只验仓库自己的合并 / 去重 / 降级语义。

/** 可控的历史读取器：记录每个会话被拉了几次，按序给出结果或错误。 */
function fakeLoader(results) {
  const calls = [];
  let index = 0;
  return {
    calls,
    load: async (sessionId) => {
      calls.push(sessionId);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test('回填一次就能翻出旧消息，之后不再重复拉', async () => {
  const history = createHistory();
  const loader = fakeLoader([['旧的一', '旧的二']]);
  assert.equal(history.up('s1', ''), null, '回填之前内存里什么都没有');
  await history.hydrate('s1', loader.load);
  assert.deepEqual(loader.calls, ['s1']);
  assert.equal(history.up('s1', ''), '旧的二', '最新的在栈顶');
  assert.equal(history.up('s1', ''), '旧的一');
  assert.deepEqual(loader.calls, ['s1'], '已经初始化过就不再拉第二次');
});

test('回填的历史排在内存记录前面，连续重复只留一条（与 push 同一口径）', async () => {
  const history = createHistory();
  history.push('s1', '刚发的');
  await history.hydrate('s1', async () => ['很早的', '很早的', '刚发的']);
  assert.deepEqual(history.entries('s1'), ['很早的', '刚发的']);
  assert.equal(history.up('s1', ''), '刚发的');
  assert.equal(history.up('s1', ''), '很早的');
});

test('拉取失败只 warn 一次、不抛，内存历史照旧能用，且保留重试机会', async () => {
  const history = createHistory();
  history.push('s1', '内存里的');
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args);
  try {
    const loader = fakeLoader([new Error('会话没打开')]);
    await history.hydrate('s1', loader.load);
    await history.hydrate('s1', loader.load);
    // 失败不锁死：会话可能只是还在加载（openState: 'loading'），下次挂载要能补上
    assert.equal(loader.calls.length, 2, '失败后保留重试机会');
  } finally {
    console.warn = original;
  }
  assert.equal(warns.length, 1, '同一个会话只吵一次，别刷屏');
  assert.deepEqual(history.entries('s1'), ['内存里的'], '内存历史不受影响');
  assert.equal(history.up('s1', ''), '内存里的');
});

test('读到 0 条不锁死：会话加载完成后再次回填能补上历史', async () => {
  const history = createHistory();
  const empty = fakeLoader([[]]);
  await history.hydrate('s1', empty.load);
  assert.equal(empty.calls.length, 1);
  // 模拟会话加载完成后窗口里终于有事件
  const loaded = fakeLoader([['补上的旧话']]);
  await history.hydrate('s1', loaded.load);
  assert.equal(loaded.calls.length, 1, '空结果不算初始化成功，必须允许再读一次');
  assert.deepEqual(history.entries('s1'), ['补上的旧话']);
});

test('会话切换后各自独立初始化：各拉一次，历史互不串', async () => {
  const history = createHistory();
  const loader = fakeLoader([['A-旧'], ['B-旧']]);
  await history.hydrate('a', loader.load);
  await history.hydrate('b', loader.load);
  await history.hydrate('a', loader.load);
  assert.deepEqual(loader.calls, ['a', 'b']);
  assert.deepEqual(history.entries('a'), ['A-旧']);
  assert.deepEqual(history.entries('b'), ['B-旧']);
});

test('同一次拉取还没回来时再按 ↑ 不会重复发起', async () => {
  const history = createHistory();
  let settle;
  let calls = 0;
  const load = () => {
    calls += 1;
    return new Promise((resolve) => {
      settle = resolve;
    });
  };
  const first = history.hydrate('s1', load);
  const second = history.hydrate('s1', load);
  settle(['旧消息']);
  await Promise.all([first, second]);
  assert.equal(calls, 1, '在途请求只允许一个');
  assert.deepEqual(history.entries('s1'), ['旧消息']);
});

test('原生默认回填超过 2000 条仍全部保留，不形成历史功能天花板', async () => {
  const history = createHistory();
  const many = Array.from({ length: 2100 }, (_unused, index) => 'm' + index);
  await history.hydrate('s1', async () => many);
  assert.equal(history.entries('s1').length, 2100);
  assert.equal(history.entries('s1')[0], 'm0');
  assert.equal(history.entries('s1')[2099], 'm2099');
  assert.equal(history.up('s1', ''), 'm2099');
});

test('默认逐页超过 2000 条仍可完整 ↑ 回翻与 ↓ 返回每条及原草稿', async () => {
  const history = createHistory();
  const texts = Array.from({ length: 2105 }, (_unused, index) => 'message-' + index);
  const draft = { text: '当前 @ref 草稿', references: [{ id: 'ref' }] };
  let start = texts.length - 50;
  let loads = 0;
  await history.hydrate('s1', async () => ({ texts: texts.slice(start), hasMore: true }));
  for (let i = texts.length - 1; i >= start; i--) assert.equal(history.up('s1', draft), texts[i]);
  while (start > 0) {
    assert.equal(history.atOldest('s1'), true);
    const oldStart = start;
    const previousLength = history.entries('s1').length;
    start = Math.max(0, start - 50);
    assert.equal(await history.loadMore('s1', async () => {
      loads++;
      return { texts: texts.slice(start), hasMore: start > 0 };
    }), true);
    assert.equal(history.entries('s1').length, previousLength + oldStart - start);
    for (let i = oldStart - 1; i >= start; i--) assert.equal(history.up('s1', draft), texts[i]);
  }
  assert.equal(loads, 42);
  assert.equal(history.entries('s1').length, 2105);
  assert.equal(history.canLoadMore('s1'), false);
  assert.equal(history.up('s1', draft), texts[0]);
  assert.equal(await history.loadMore('s1', () => { throw new Error('hasMore 已终止，不应再加载'); }), false);
  for (let i = 1; i < texts.length; i++) assert.equal(history.down('s1'), texts[i]);
  assert.equal(history.down('s1'), draft);
  assert.equal(history.down('s1'), null);
});

test('loadMore 没有新条目或更早部分只含空白与连续重复时返回 false', async () => {
  const history = createHistory();
  await history.hydrate('s1', async () => ({ texts: ['c', 'd', 'e'], hasMore: true }));
  assert.equal(await history.loadMore('s1', async () => ({ texts: ['c', 'd', 'e'], hasMore: true })), false);
  assert.equal(await history.loadMore('s1', async () => ({ texts: ['', ' ', 'c', 'c', 'd', 'e'], hasMore: false })), false);
  assert.deepEqual(history.entries('s1'), ['c', 'd', 'e']);
  assert.equal(history.canLoadMore('s1'), false);
});

test('显式 limit 裁掉全部更早页时 loadMore 返回 false，不虚报增加', async () => {
  const history = createHistory({ limit: 3 });
  await history.hydrate('s1', async () => ({ texts: ['c', 'd', 'e'], hasMore: true }));
  assert.equal(history.up('s1', '草稿'), 'e');
  assert.equal(history.up('s1', ''), 'd');
  assert.equal(history.up('s1', ''), 'c');
  const loaded = await history.loadMore('s1', async () => ({ texts: ['a', 'b', 'c', 'd', 'e'], hasMore: false }));
  assert.equal(loaded, false);
  assert.deepEqual(history.entries('s1'), ['c', 'd', 'e']);
  assert.equal(history.up('s1', ''), 'c');
  assert.equal(history.down('s1'), 'd');
  assert.equal(history.down('s1'), 'e');
  assert.equal(history.down('s1'), '草稿');
});

test('翻到最早一条时懒加载更早的一页，游标跟着挪到原来那条', async () => {
  const history = createHistory();
  await history.hydrate('s1', async () => ({ texts: ['乙', '丙'], hasMore: true }));
  assert.equal(history.up('s1', ''), '丙');
  assert.equal(history.up('s1', ''), '乙');
  assert.equal(history.atOldest('s1'), true, '已经翻到栈里最早一条');
  assert.equal(history.canLoadMore('s1'), true, '会话记录还有更早的');
  // 再向上翻一页：新历史插到前面，游标锚定回「乙」，于是还能继续往前翻
  const more = await history.loadMore('s1', async () => ({ texts: ['甲', '乙', '丙'], hasMore: false }));
  assert.equal(more, true);
  assert.deepEqual(history.entries('s1'), ['甲', '乙', '丙']);
  assert.equal(history.up('s1', ''), '甲', '接着往上翻，而不是停住');
  assert.equal(history.canLoadMore('s1'), false, 'hasMore 为假之后不再请求');
});

test('loadMore 不重复合并已有条目：只取快照里新多出来的更早部分', async () => {
  const history = createHistory();
  await history.hydrate('s1', async () => ({ texts: ['乙', '丙'], hasMore: true }));
  await history.loadMore('s1', async () => ({ texts: ['甲', '乙', '丙'], hasMore: false }));
  assert.deepEqual(history.entries('s1'), ['甲', '乙', '丙'], '乙、丙 不能重复出现');
});

test('没有注入读取器时 hydrate 什么都不做，也不抛', async () => {
  const history = createHistory();
  await assert.doesNotReject(() => history.hydrate('s1', undefined));
  assert.deepEqual(history.entries('s1'), []);
});

test('回填不抽走正在看的那一条：游标锚定到同一条文本，继续往前翻', async () => {
  const history = createHistory();
  history.push('s1', '甲');
  assert.equal(history.up('s1', '草稿'), '甲');
  // 回填是异步的，完成时用户可能已经在翻历史；旧实现无条件复位游标，表现为「按 ↑ 又跳回最新」。
  // 会话记录是权威来源（含插件运行期间发过的消息），所以快照里也带着「甲」。
  await history.hydrate('s1', async () => ['更早的', '甲']);
  assert.equal(history.isBrowsing('s1'), true, '正在回翻时不能退出回翻');
  assert.equal(history.up('s1', ''), '更早的', '继续往前翻，而不是回到最新一条');
});

test('没在回翻时回填：下次 ↑ 从最新一条开始', async () => {
  const history = createHistory();
  history.push('s1', '甲');
  await history.hydrate('s1', async () => ['更早的', '甲']);
  assert.equal(history.isBrowsing('s1'), false);
  assert.equal(history.up('s1', ''), '甲', '栈顶永远是最新一条');
});

test('回填用会话记录整体替换：内存记过的那条不会在栈里占两格', async () => {
  const history = createHistory();
  history.push('s1', '甲');
  await history.hydrate('s1', async () => ['更早的', '甲']);
  assert.deepEqual(history.entries('s1'), ['更早的', '甲'], '甲 只出现一次');
});
