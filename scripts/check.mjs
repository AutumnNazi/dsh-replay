import assert from 'node:assert/strict';
import { readFile, stat, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { buildClientBundle } from './bundle.mjs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

// ── 清单契约 ────────────────────────────────────────────────────────────────
assert.equal(pkg.name, '@bxzy/dsh-replay');
assert.equal(pkg.version, '0.2.0');
assert.deepEqual(pkg.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/' });
assert.ok(pkg.scripts.test.split(/\s+/).includes('test/release.test.js'));
assert.equal(pkg.type, 'module');
assert.equal(pkg.main, './lib/index.js');
assert.equal(pkg.dsh.manifestVersion, 1);
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(pkg.dsh.client.platform, 'web');
assert.equal(pkg.exports['./client'], './lib/client.js');
assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml');
assert.deepEqual(pkg.files, ['lib/', 'locale/', 'cordis.patch.yml', 'README.en.md']);
assert.equal(pkg.dependencies, undefined, '不允许新增依赖');
assert.equal(pkg.devDependencies, undefined, '不允许新增依赖');
assert.deepEqual(pkg.dsh.client.external, ['react'], '只共享宿主已提供的 react');
assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'));
assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-shortcuts'));
// 重发要调 sessions 服务：宿主包不声明就拿不到 binding，按钮点了也没反应
assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller'));

// ── 构建产物与补丁 ──────────────────────────────────────────────────────────
for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
  assert.ok((await stat(new URL(file, root))).size > 0, file + ' 必须真实生成');
}
const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
assert.deepEqual(patch.trim().split(/\r?\n/).map((line) => line.trim()), [
  '- insert:',
  '- id: dsh-replay', 'name: ' + JSON.stringify(pkg.name), 'group: true',
  '- id: dsh-replay.history', 'name: ' + JSON.stringify(pkg.name + '/history'),
  '- id: dsh-replay.retry', 'name: ' + JSON.stringify(pkg.name + '/retry'),
]);

// ── 源码里不许出现 DOM 劫持 ──────────────────────────────────────────────────
// 宿主 practices.md 明文禁止写别人组件的 DOM；本插件连读都不读 DOM，全部走服务面。
/**
 * document 是浏览器的 DOM 面，插件原则上不碰：读别人组件的 DOM 是 practices.md 明文禁止的。
 * 唯一必要例外是「复制到剪贴板」的回落路径——navigator.clipboard 不可用时，
 * 宿主自己也是用「临时 textarea + document.execCommand('copy')」兜底（web shell @660099）。
 * 所以只对 src/clipboard.js 放行，且那个文件里 document 只用于瞬时建/删一个离屏 textarea；
 * 其它文件（含 src/retry.js）照旧全禁，整条 document 禁令不放开。
 */
const DOM_TOKEN = 'document.';
const DOM_TOKEN_ALLOWED = new Set(['src/clipboard.js']);

const FORBIDDEN = [
  'addEventListener(',
  'removeEventListener(',
  'dispatchEvent(',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  '.preventDefault(',
  '.stopPropagation(',
  // 允许 history-client.js 只在历史写回成功分支调用宿主 consume，不允许直接拦截原生事件。
  '.consume(',
  'localStorage',
  'sessionStorage',
  'document.',
  'window.',
];
const srcDir = new URL('src/', root);
const srcFiles = (await readdir(srcDir)).filter((name) => name.endsWith('.js'));
assert.ok(srcFiles.length >= 4, 'src 下应有分模块文件');
const historyClientSource = await readFile(new URL('src/history-client.js', root), 'utf8');
assert.equal((historyClientSource.match(/input[.]consume[(][)]/g) ?? []).length, 1, '宿主 consume 只能调用一处');
assert.match(historyClientSource, /if [(]alive && composers[.]writeDraft[(]shell, next[)][)] [{][\s\S]*?input[.]consume[(][)]/, '只能在历史写回成功时消费方向键');
const historyComposerSource = await readFile(new URL('src/composer.js', root), 'utf8');
assert.ok(!historyComposerSource.includes('scrollIntoView') && !historyComposerSource.includes('scrollTop'), '历史适配器不得滚动宿主对话');
assert.ok(!historyComposerSource.includes("actions.setDraft('')"), '不再依靠清空草稿改变选区');
for (const file of srcFiles) {
  const source = await readFile(new URL(file, srcDir), 'utf8');
  for (const token of FORBIDDEN) {
    if (token === DOM_TOKEN && DOM_TOKEN_ALLOWED.has('src/' + file)) continue;
    if (token === '.consume(' && file === 'history-client.js') continue;
    assert.ok(!source.includes(token), 'src/' + file + ' 里出现了被禁止的 DOM 手段：' + token);
  }
}

for (const name of ['settings.js', 'settings-react.js', 'settings-page.js']) {
  await assert.rejects(stat(new URL('src/' + name, root)), { code: 'ENOENT' });
}

// ── chat 行的遮蔽范围：只有 src/retry-client.js 可以碰 'user' ──────────────────────
// conversation.chat.node 是 keyed 槽：拿内置 key 当自己的 key 就是把宿主那一格整个换掉。
// 需求变更后只剩一个必要遮蔽：重试图标必须与「复制」并列，而宿主操作行没有插图标的口子
// （MessageIconActions 的 extraActions 只有宿主内部传得进去），只能接管 'user' 那一格。
// 范围收到「只有 src/retry-client.js（接线处）、只有 'user'」，steering / context / turn-trigger 等照旧全禁。
const SHADOW_ALLOWED = new Set(['src/retry-client.js']);
const SHADOWED_KEYS = ['user', 'steering', 'context', 'turn-trigger', 'system-prompt', 'command'];
for (const file of srcFiles) {
  const source = await readFile(new URL(file, srcDir), 'utf8');
  for (const key of SHADOWED_KEYS) {
    if (key === 'user' && SHADOW_ALLOWED.has('src/' + file)) continue;
    assert.ok(
      !new RegExp("key:\\s*['\"]" + key + "['\"]").test(source),
      'src/' + file + ' 里遮蔽了内置的 conversation.chat.node key：' + key,
    );
  }
  // practices.md:33/35：客户端插件不得 import 宿主的 client-ui 包与 primitives，图标一律自绘
  assert.ok(
    !/from\s+['"]@deepseek-ai\/dsh-client-ui-/.test(source),
    'src/' + file + ' 里 import 了宿主 client-ui 包',
  );
  assert.ok(
    !/from\s+['"]@deepseek-ai\/dsh-client-ui-primitives/.test(source),
    'src/' + file + ' 里 import 了 primitives',
  );
}

// ── 模块加载器契约 ──────────────────────────────────────────────────────────
let registration;
const bundle = await readFile(new URL('lib/client.js', root), 'utf8');
assert.equal(bundle, (await buildClientBundle()).code, '发布 bundle 必须与当前源码一致');
assert.ok(bundle.includes('__ModuleLoader__'), 'lib/client.js 必须是模块加载器包装');
// 构建产物同样不许出现 DOM 劫持手段：src 干净不代表产物干净（拼接、包装都可能引入）
for (const token of FORBIDDEN.filter(
  (item) => item !== 'document.' && item !== 'window.' && item !== '.consume(',
)) {
  assert.ok(!bundle.includes(token), 'lib/client.js 里出现了被禁止的 DOM 手段：' + token);
}
// 构建产物同样不得遮蔽内置 key（src 干净不代表拼接后干净）。
// 'user' 例外：它是 src/retry.js 里那唯一一处刻意遮蔽，产物里出现是预期行为。
for (const key of SHADOWED_KEYS.filter((item) => item !== 'user')) {
  assert.ok(
    !new RegExp('key:\\s*"' + key + '"').test(bundle),
    'lib/client.js 里遮蔽了内置的 conversation.chat.node key：' + key,
  );
}
vm.runInNewContext(bundle, {
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
});
assert.equal(registration.id, pkg.name);

const externals = [];
const api = registration.factory((name) => {
  externals.push(name);
  if (name === 'react') return {};
  throw new Error('本插件只允许 require react，实际请求了 ' + name);
});
assert.deepEqual(externals, ['react'], '工厂函数只允许向宿主索取 react');
assert.equal(typeof api.apply, 'function');
assert.deepEqual(Array.from(api.inject), ['slots', 'conversation', 'shortcuts', 'sessions', 'locale', 'remote.pluginInventory']);
for (const name of ['createHistory', 'isFirstLine', 'isRecallTrigger', 'classifyInput', 'decideAction', 'createComposers']) {
  assert.equal(typeof api[name], 'function', '导出缺失：' + name);
}
for (const name of ['extractPromptText', 'createRetryAction', 'UserMessageView', 'formatMessageClock']) {
  assert.equal(typeof api[name], 'function', '导出缺失：' + name);
}
// 剪贴板必须独立成模块：document 的放行范围就是它，不能混回消息行组件里
assert.equal(typeof api.writeClipboardText, 'function', '导出缺失：writeClipboardText');
// 旧会话兼容：事件口径与文本提取是重试图标与输入历史回填共用的两份公共逻辑，不得退化
for (const name of ['isUserPromptEvent', 'userPromptIdOf', 'userPromptTextOf', 'isRetryableUserNode']) {
  assert.equal(typeof api[name], 'function', '导出缺失：' + name);
}
assert.equal(
  api.isUserPromptEvent({ type: 'user/message', seq: 9, data: { content: '旧事件' } }),
  true,
  '旧会话事件（没有 surfaceOp / source / data.id）必须仍按用户消息处理，否则旧对话里永远没有重试图标',
);
assert.equal(api.extractPromptText('旧版本存成字符串'), '旧版本存成字符串', '字符串内容也要读得出文本');
for (const name of ['createSettings', 'useSettings', 'SettingsSection', 'DEFAULT_SETTINGS', 'SETTINGS_STORAGE_KEY']) {
  assert.equal(api[name], undefined, '废弃设置不得留在发布 API');
}

// ── 走的是公开扩展面，不是 shortcuts.register ───────────────────────────────
const clientSource = await readFile(new URL('src/history-client.js', root), 'utf8');
assert.ok(clientSource.includes('observeFixedInput'), '必须用 observeFixedInput 观察按键');
assert.ok(!/\.shortcuts\.register\(/.test(clientSource), 'shortcuts.register 在 Web 上绑不了裸方向键，不得使用');
assert.ok(clientSource.includes('registerFixed'), '应在快捷键清单里声明 ↑/↓');
assert.ok(clientSource.includes('ctx.effect'), '订阅必须挂在 ctx.effect 上，卸载时收回');
// 槽位组件不得在 render 阶段产生副作用：必须走 useEffect（commit 阶段）
assert.ok(clientSource.includes('React.useEffect'), '槽位组件必须在 commit 阶段报告挂载，不能在 render 里做');
assert.ok(/return null;/.test(clientSource), '槽位组件不得渲染 DOM');
// 遮蔽必须靠更低的 priority：keyed 槽同 key 同 priority 会直接抛错，priority 升序取第一个存活条目
assert.ok(/priority:\s*-1/.test(await readFile(new URL('src/retry-client.js', root), 'utf8')), '接管内置 user 行必须显式给出比内置（0）更低的 priority');

const rootClient = await readFile(new URL('src/client.js', root), 'utf8');
assert.ok(!rootClient.includes('settings.section'));
assert.ok(rootClient.includes('createComponentController'));
assert.ok(rootClient.includes('clearInterval'));
for (const [specifier, title] of [['', 'dsh-replay'], ['history/', 'Input History'], ['retry/', 'Prompt Replay']]) {
  const exported = './' + specifier + 'locale/*.json';
  const localePath = pkg.exports[exported].replace('*', 'en');
  const english = JSON.parse(await readFile(new URL(localePath, root), 'utf8'));
  const chinese = JSON.parse(await readFile(new URL(localePath.replace('/en.json', '/zh-cn.json'), root), 'utf8'));
  assert.equal(english.meta.title, title);
  if (specifier === '') assert.equal(chinese.meta.title, 'dsh-replay');
  assert.deepEqual(Object.keys(english.meta), Object.keys(chinese.meta));
}
for (const [specifier, moduleName] of [['./history', pkg.name + '/history'], ['./retry', pkg.name + '/retry']]) {
  const entry = await import(new URL(pkg.exports[specifier], root));
  assert.equal(entry.name, moduleName);
  assert.equal(typeof entry.apply, 'function');
}

const host = await import(new URL('lib/index.js', root));
assert.equal(host.name, pkg.name);
assert.equal(typeof host.apply, 'function');

console.log('清单/补丁/客户端包/DOM 禁令/commit 阶段/扩展面 契约全部通过');
