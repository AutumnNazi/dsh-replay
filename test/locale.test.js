import test from 'node:test';
import assert from 'node:assert/strict';
import * as replayLocale from '../src/locale.js';

const REQUIRED_KEYS = [
  'brand.name', 'brand.description',
  'component.history.name', 'component.history.description',
  'component.retry.name', 'component.retry.description',
  'copy.label', 'copy.done', 'copy.title',
  'retry.failure', 'retry.empty', 'retry.unavailable', 'retry.disabled',
  'retry.label', 'retry.busy', 'retry.sending', 'retry.title',
  'clock.md', 'clock.ymd',
  'history.prev', 'history.next', 'history.missingSession', 'history.unavailable',
  'history.pageFailed', 'history.hydrated', 'history.draftChanged',
  'history.unregisterFailed', 'history.fixedFailed', 'history.readFailed',
  'history.loadMoreFailed', 'history.moreFailed', 'history.mountFailed',
  'composer.shellFailed', 'composer.snapshotFailed', 'composer.unsubscribeFailed',
  'composer.subscribeFailed', 'composer.readFailed', 'composer.writeFailed',
];

test('中英词典 key 一致，覆盖两个组件与所有已知可见文案', () => {
  const { zh, en } = replayLocale.LOCALES;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(zh).sort(), REQUIRED_KEYS.toSorted());
  for (const dict of [zh, en]) {
    assert.equal(Object.isFrozen(dict), true);
    for (const key of REQUIRED_KEYS) assert.equal(typeof dict[key], 'string', key);
  }
});

test('通过宿主 locale 翻译品牌名，不注册共享词典', () => {
  assert.equal(typeof replayLocale.createReplayI18n, 'function');
  const locale = {
    getSnapshot: () => ({ active: 'zh' }),
    resolveText: (text) => text.zh ?? text.en,
    subscribe: () => () => {},
  };
  const i18n = replayLocale.createReplayI18n(locale);
  assert.equal(i18n.t('brand.name'), '回言');
  assert.equal(i18n.language(), 'zh-CN');
  assert.equal(replayLocale.translateReplay('brand.name', 'en-US'), 'Re:Play');
  assert.equal(replayLocale.translateReplay('component.retry.name', 'en-US'), 'Prompt Replay');
});


test('纯翻译支持 zh-CN、en-US 与未知语言英文回退，缺失 key 保留', () => {
  assert.equal(typeof replayLocale.translateReplay, 'function');
  const t = replayLocale.translateReplay;
  for (const language of ['zh', 'zh-CN', 'ZH-cn']) assert.equal(t('copy.label', language), '复制');
  for (const language of ['en', 'en-US', 'fr-FR', undefined]) assert.equal(t('copy.label', language), 'Copy');
  assert.equal(t('missing.key', 'zh-CN'), 'missing.key');
  for (const language of ['zh-CN', 'en-US']) {
    for (const key of REQUIRED_KEYS) assert.notEqual(t(key, language), key, key);
  }
});

function nativeLocale(active = 'zh') {
  let snapshot = { active };
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    resolveText: (text) => snapshot.active === 'zh' ? text.zh ?? text.en : text.en,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setActive(active) { snapshot = { active }; for (const fn of listeners) fn(); },
    get size() { return listeners.size; },
  };
}

test('同一翻译实例跟随宿主语言动态变化，日期参数原样插值', () => {
  const locale = nativeLocale();
  const i18n = replayLocale.createReplayI18n(locale);
  assert.equal(i18n.t('clock.md', { m: '06', d: '04' }), '06月04日');
  const sessionId = '会话$&{m}';
  assert.equal(i18n.t('history.loadMoreFailed', { sessionId }), '[dsh-replay] 加载更早的会话历史失败：' + sessionId);
  locale.setActive('en');
  assert.equal(i18n.language(), 'en-US');
  assert.equal(i18n.t('copy.label'), 'Copy');
  assert.equal(i18n.t('clock.ymd', { y: 2026, m: '06', d: '04' }), '2026-06-04');
  assert.equal(i18n.t('clock.md', { m: 0 }), '0/{d}');
  locale.setActive('zh');
  assert.equal(i18n.language(), 'zh-CN');
  assert.equal(i18n.t('copy.label'), '复制');
});


test('两个组件并存且共用回调时，一个 dispose 不影响另一个或宿主订阅', () => {
  const locale = nativeLocale();
  locale.register = () => { throw new Error('不得注册共享词典'); };
  locale.setLocale = () => { throw new Error('不得改写用户语言'); };
  const history = replayLocale.createReplayI18n(locale);
  const retry = replayLocale.createReplayI18n(locale);
  assert.equal(typeof history.subscribe, 'function');
  assert.equal(typeof history.dispose, 'function');
  let calls = 0;
  const callback = () => calls++;
  const externalOff = locale.subscribe(callback);
  const historyOff = history.subscribe(callback);
  const retryOff = retry.subscribe(callback);
  assert.equal(locale.size, 3);
  locale.setActive('en');
  assert.equal(calls, 3);
  history.dispose();
  history.dispose();
  historyOff();
  assert.equal(locale.size, 2);
  locale.setActive('zh');
  assert.equal(calls, 5);
  assert.equal(retry.t('copy.label'), '复制');
  retryOff();
  retryOff();
  retry.dispose();
  assert.equal(locale.size, 1);
  externalOff();
  assert.equal(locale.size, 0);
  assert.throws(() => history.subscribe(callback), /disposed/);
});


test('无宿主服务时英文回退，但不完整宿主契约直接报错', () => {
  const i18n = replayLocale.createReplayI18n();
  assert.equal(i18n.language(), 'en-US');
  assert.equal(i18n.t('copy.label'), 'Copy');
  const stop = i18n.subscribe(() => {});
  stop();
  i18n.dispose();
  assert.throws(() => replayLocale.createReplayI18n({}), /getSnapshot/);
  assert.throws(() => replayLocale.createReplayI18n({ getSnapshot() {} }), /resolveText/);
});

test('宿主读语言、翻译、订阅与清理错误原样抛出，不伪装成功', () => {
  const error = new Error('host failure 原始详情');
  const locale = nativeLocale();
  const i18n = replayLocale.createReplayI18n(locale);
  locale.getSnapshot = () => { throw error; };
  assert.throws(() => i18n.language(), (actual) => actual === error);
  locale.resolveText = () => { throw error; };
  assert.throws(() => i18n.t('copy.label'), (actual) => actual === error);
  locale.subscribe = () => { throw error; };
  assert.throws(() => i18n.subscribe(() => {}), (actual) => actual === error);
  locale.subscribe = () => () => { throw error; };
  i18n.subscribe(() => {});
  assert.throws(() => i18n.dispose(), (actual) => actual === error);
});


test('遵循宿主 resolveText 的语言 fallback 链而非自行猜测', () => {
  let active = 'zh-CN';
  let resolves = 0;
  const locale = {
    getSnapshot: () => ({ active }),
    resolveText(text) {
      resolves++;
      return ['zh-CN', 'zh', 'zh-Hans'].includes(active) ? text.zh ?? text.en : text.en;
    },
    subscribe: () => () => {},
  };
  const i18n = replayLocale.createReplayI18n(locale);
  assert.equal(i18n.language(), 'zh-CN');
  assert.equal(i18n.t('copy.label'), '复制');
  active = 'en-US';
  assert.equal(i18n.language(), 'en-US');
  assert.equal(i18n.t('copy.label'), 'Copy');
  active = 'unknown';
  assert.equal(i18n.language(), 'en-US');
  assert.equal(i18n.t('copy.label'), 'Copy');
  assert.equal(i18n.t('unknown.key'), 'unknown.key');
  assert.equal(resolves, 3);
  assert.equal(replayLocale.translateReplay('clock.ymd', 'en-US', { y: 0, m: false, d: '' }), '0-false-');
});
